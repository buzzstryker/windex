import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  seasonLabel as getSeasonLabel,
  type Group,
  type Season,
  type Section,
  type SeasonStandingsPayload,
} from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { BOOTSTRAP_STALE_MS, fetchBootstrap, leaderboardKeys } from '@/lib/leaderboardData';
import { isPermanentQuery } from '@/lib/queryClient';
import { selectedGroupKey, userPrefs } from '@/lib/userPrefs';
import { logUserEvent } from '@/lib/userEvents';

type GroupWithSection = Group & { sectionName?: string };

type GroupContextValue = {
  /** LEAGUE groups only — the player-visible universe. Rosters are excluded
   *  here (migration 052) so every consumer of `groups` (switcher, drawer,
   *  default resolution, myGroups) hides them automatically. Rosters live in
   *  `rosterGroups`. */
  groups: GroupWithSection[];
  /** ROSTER groups (prospect pools). Super-admin-only surface: the browse-a-
   *  roster picker in AddInvitePlayerSheet. Never shown as a selectable group. */
  rosterGroups: GroupWithSection[];
  /** Groups the current user is an active member of, sorted by group_members.joined_at DESC (most-recently-joined first). */
  myGroups: GroupWithSection[];
  sections: Section[];
  selectedGroup: GroupWithSection | null;
  /** True when the current user is an active member of the selected group.
   *  Consumers use this to gate write affordances (e.g. Add Round) to match
   *  the league_rounds/league_scores INSERT RLS, which requires
   *  am_i_group_member(group_id). Viewing is open to everyone. */
  selectedGroupIsMine: boolean;
  selectedSeason: Season | null;
  seasons: Season[];
  selectGroup: (group: GroupWithSection) => void;
  selectSeason: (season: Season) => void;
  loading: boolean;
  seasonLabel: (s: Season) => string;
  /** Forced refetch of the bootstrap (pull-to-refresh). */
  reload: () => Promise<void>;
  isSuperAdmin: boolean;
  isGroupAdmin: (groupId: string) => boolean;
  myPlayerIds: string[];
  /** True when any players row linked to this auth user has is_heckler
   *  (migration 055) — a global spectator. Mirrors the am_i_heckler() SQL
   *  helper, resolved from the same bootstrap that produces myPlayerIds. */
  amHeckler: boolean;
  /** display_name / email of the signed-in user's earliest-created players row
   *  — the same row getAuthorPlayerId() picks for chat authorship, so the
   *  drawer identifies you as the name your messages are posted under. Null
   *  until resolved, or when no players row is linked. */
  myDisplayName: string | null;
  myEmail: string | null;
  dataVersion: number;
  invalidateData: () => void;
  isSelectedSeasonActive: boolean;
  /** Selected season's standings are a frozen snapshot (seasons.closed_at, migration 058). */
  isSelectedSeasonClosed: boolean;
  /** The season the bootstrap picked and already fetched (in progress today, else latest started). */
  defaultSeasonId: string | null;
};

const GroupContext = createContext<GroupContextValue | null>(null);

const EMPTY_GROUPS: GroupWithSection[] = [];
const EMPTY_SEASONS: Season[] = [];
const EMPTY_IDS: string[] = [];

/**
 * App-open data comes from ONE call, get_leaderboard_bootstrap (migration 061),
 * cached on the device by TanStack Query (lib/queryClient.ts): a cached
 * bootstrap renders at once and revalidates in the background. It replaces the
 * chain this context used to run — am_i_super_admin -> players -> group_members,
 * in parallel with groups + sections, then seasons — and seeds the selected
 * season's standings into its own cache entry, so the Standings tab renders
 * without a second request.
 *
 * Group resolution (requested pick -> most-recently-joined league -> first
 * league by name) now happens in the RPC; this context only supplies the
 * persisted pick from userPrefs, which is local and read first.
 */
export function GroupProvider({ children }: { children: React.ReactNode }) {
  const { signedIn, ready, userId } = useAuth();
  const queryClient = useQueryClient();

  // Persisted manual selection per user_id. Loaded before the bootstrap query
  // is enabled so the stored pick is sent as p_group_id.
  const [persistedChoiceId, setPersistedChoiceId] = useState<string | null>(null);
  const [persistedChoiceLoaded, setPersistedChoiceLoaded] = useState(false);

  // A season picked in the season picker. null = the bootstrap's default.
  const [seasonOverrideId, setSeasonOverrideId] = useState<string | null>(null);

  const [dataVersion, setDataVersion] = useState(0);

  useEffect(() => {
    if (!userId) {
      setPersistedChoiceId(null);
      setPersistedChoiceLoaded(true);
      return;
    }
    let cancelled = false;
    setPersistedChoiceLoaded(false);
    userPrefs.getItem(selectedGroupKey(userId))
      .then((v) => {
        if (cancelled) return;
        setPersistedChoiceId(v);
        setPersistedChoiceLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setPersistedChoiceId(null);
        setPersistedChoiceLoaded(true);
      });
    return () => { cancelled = true; };
  }, [userId]);

  const bootstrapEnabled = ready && signedIn && !!userId && persistedChoiceLoaded;
  const bootstrapKey = leaderboardKeys.bootstrap(userId ?? '', persistedChoiceId);
  const bootstrap = useQuery({
    queryKey: bootstrapKey,
    queryFn: () => fetchBootstrap(userId!, persistedChoiceId),
    enabled: bootstrapEnabled,
    staleTime: BOOTSTRAP_STALE_MS,
  });
  const data = bootstrap.data;

  // Seed the selected season's cache entry from the bootstrap, and drop any
  // cached season whose open/closed state the server now reports differently
  // (an admin closed or reopened it) so a stale snapshot is never served.
  useEffect(() => {
    if (!data || !userId || !data.selected_group_id) return;
    const gid = data.selected_group_id;
    for (const s of data.seasons) {
      const key = leaderboardKeys.season(userId, gid, s.id);
      const cached = queryClient.getQueryData<SeasonStandingsPayload>(key);
      if (cached && (cached.closed_at ?? null) !== (s.closed_at ?? null)) {
        queryClient.removeQueries({ queryKey: key, exact: true });
      }
    }
    if (data.selected_season) {
      const key = leaderboardKeys.season(userId, gid, data.selected_season.season_id);
      const cachedAt = queryClient.getQueryState(key)?.dataUpdatedAt ?? 0;
      if (bootstrap.dataUpdatedAt >= cachedAt) {
        queryClient.setQueryData(key, data.selected_season, { updatedAt: bootstrap.dataUpdatedAt });
      }
    }
  }, [data, bootstrap.dataUpdatedAt, userId, queryClient]);

  const allGroups: GroupWithSection[] = useMemo(
    () => (data?.groups ?? []).map((g) => ({ ...g, sectionName: g.section_name ?? undefined })),
    [data],
  );
  // Split by type: `groups` carries LEAGUES only (the single filter point that
  // keeps rosters out of the switcher, drawer, default resolution, and
  // myGroups). Rosters go to `rosterGroups` for the super-admin browse picker.
  const groups = useMemo(() => allGroups.filter((g) => g.group_type !== 'roster'), [allGroups]);
  const rosterGroups = useMemo(() => allGroups.filter((g) => g.group_type === 'roster'), [allGroups]);
  const sections: Section[] = useMemo(() => {
    const seen = new Map<string, string>();
    for (const g of data?.groups ?? []) {
      if (g.section_id && g.section_name) seen.set(g.section_id, g.section_name);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  const me = data?.me;
  const myMembershipJoinedAt = useMemo(
    () => new Map((me?.memberships ?? []).map((m) => [m.group_id, m.joined_at])),
    [me],
  );
  const adminGroupIds = useMemo(
    () => new Set((me?.memberships ?? []).filter((m) => m.is_admin).map((m) => m.group_id)),
    [me],
  );
  const isGroupAdmin = useCallback((groupId: string) => adminGroupIds.has(groupId), [adminGroupIds]);

  // Groups the user is an active member of, ordered by group_members.joined_at
  // DESC (most-recently-joined first) with name as a stable tie-break.
  const myGroups = useMemo(() => {
    const filtered = groups.filter((g) => myMembershipJoinedAt.has(g.id));
    return [...filtered].sort((a, b) => {
      const ja = myMembershipJoinedAt.get(a.id) ?? '';
      const jb = myMembershipJoinedAt.get(b.id) ?? '';
      const cmp = jb.localeCompare(ja);
      return cmp !== 0 ? cmp : a.name.localeCompare(b.name);
    });
  }, [groups, myMembershipJoinedAt]);

  const selectedGroup = useMemo(
    () => groups.find((g) => g.id === data?.selected_group_id) ?? null,
    [groups, data?.selected_group_id],
  );
  const seasons = data?.seasons ?? EMPTY_SEASONS;
  const selectedSeason = useMemo(() => {
    const wanted = seasonOverrideId ?? data?.selected_season_id ?? null;
    return seasons.find((s) => s.id === wanted) ?? null;
  }, [seasons, seasonOverrideId, data?.selected_season_id]);

  const today = new Date().toISOString().slice(0, 10);
  const isSelectedSeasonActive = selectedSeason ? selectedSeason.end_date >= today : false;
  const isSelectedSeasonClosed = !!selectedSeason?.closed_at;

  const selectGroup = useCallback((group: GroupWithSection) => {
    const prev = selectedGroup;
    if (prev && prev.id !== group.id && userId) {
      // Group switch: the previous group's open-season, All Time and bootstrap
      // entries go; its closed-season snapshots stay (immutable, never expire).
      queryClient.removeQueries({
        predicate: (q) => {
          const [root, uid, gid] = q.queryKey as [string, string, string | null];
          if (uid !== userId) return false;
          if (root === 'season') return gid === prev.id && !isPermanentQuery(q);
          if (root === 'allTime') return gid === prev.id;
          if (root === 'bootstrap') return gid === prev.id || gid === null;
          return false;
        },
      });
    }
    setSeasonOverrideId(null); // the new group's default season
    setPersistedChoiceId(group.id);
    if (userId) void userPrefs.setItem(selectedGroupKey(userId), group.id);
    // Capture-before-update semantics as before: only a user-initiated switch
    // to a different group logs group_switch.
    if (prev && prev.id !== group.id) {
      void logUserEvent('group_switch', {
        groupId: group.id,
        playerId: me?.player_ids[0] ?? null,
        metadata: { from_group_id: prev.id },
      });
    }
  }, [selectedGroup, userId, queryClient, me]);

  const selectSeason = useCallback((season: Season) => {
    setSeasonOverrideId(season.id);
  }, []);

  const reload = useCallback(async () => {
    await bootstrap.refetch();
  }, [bootstrap]);

  // A round was saved in-app: the current season's standings, All Time and the
  // bootstrap are out of date. dataVersion still bumps for screens that key
  // effects on it (Rounds tab).
  const invalidateData = useCallback(() => {
    setDataVersion((v) => v + 1);
    if (!userId) return;
    const gid = selectedGroup?.id;
    if (gid && selectedSeason) {
      void queryClient.invalidateQueries({ queryKey: leaderboardKeys.season(userId, gid, selectedSeason.id) });
    }
    if (gid) void queryClient.invalidateQueries({ queryKey: leaderboardKeys.allTime(userId, gid) });
    void queryClient.invalidateQueries({ queryKey: bootstrapKey });
  }, [userId, selectedGroup?.id, selectedSeason, queryClient, bootstrapKey]);

  const selectedGroupIsMine = selectedGroup ? myMembershipJoinedAt.has(selectedGroup.id) : false;

  // True until the picker can render correctly: no cached or fetched bootstrap
  // yet. A cached bootstrap clears this at once, before the revalidation lands.
  const loading = !ready || (signedIn && (!persistedChoiceLoaded || (!data && !bootstrap.isError)));

  return (
    <GroupContext.Provider
      value={{
        groups: signedIn ? groups : EMPTY_GROUPS,
        rosterGroups: signedIn ? rosterGroups : EMPTY_GROUPS,
        myGroups: signedIn ? myGroups : EMPTY_GROUPS,
        sections: signedIn ? sections : [],
        selectedGroup: signedIn ? selectedGroup : null,
        selectedGroupIsMine,
        selectedSeason: signedIn ? selectedSeason : null,
        seasons: signedIn ? seasons : EMPTY_SEASONS,
        selectGroup,
        selectSeason,
        loading,
        seasonLabel: getSeasonLabel,
        reload,
        isSuperAdmin: signedIn && !!me?.is_super_admin,
        isGroupAdmin,
        myPlayerIds: signedIn ? me?.player_ids ?? EMPTY_IDS : EMPTY_IDS,
        amHeckler: signedIn && !!me?.is_heckler,
        myDisplayName: signedIn ? me?.display_name ?? null : null,
        myEmail: signedIn ? me?.email ?? null : null,
        dataVersion,
        invalidateData,
        isSelectedSeasonActive,
        isSelectedSeasonClosed,
        defaultSeasonId: data?.selected_season_id ?? null,
      }}
    >
      {children}
    </GroupContext.Provider>
  );
}

export function useGroup() {
  const ctx = useContext(GroupContext);
  if (!ctx) throw new Error('useGroup inside GroupProvider');
  return ctx;
}
