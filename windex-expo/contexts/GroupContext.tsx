import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  listGroups,
  listSections,
  listSeasons,
  getStoredAccessToken,
  seasonLabel as getSeasonLabel,
  type Group,
  type Season,
  type Section,
} from '@/lib/api';
import { getApiBase, getSupabaseAnonKey } from '@/lib/config';
import { useAuth } from '@/contexts/AuthContext';
import { selectedGroupKey, userPrefs } from '@/lib/userPrefs';
import { logUserEvent } from '@/lib/userEvents';

type GroupWithSection = Group & { sectionName?: string };

type GroupContextValue = {
  groups: GroupWithSection[];
  /** Groups the current user is an active member of, sorted by group_members.joined_at DESC (most-recently-joined first). */
  myGroups: GroupWithSection[];
  sections: Section[];
  selectedGroup: GroupWithSection | null;
  selectedSeason: Season | null;
  seasons: Season[];
  selectGroup: (group: GroupWithSection) => void;
  selectSeason: (season: Season) => void;
  loading: boolean;
  seasonLabel: (s: Season) => string;
  reload: () => Promise<void>;
  isSuperAdmin: boolean;
  isGroupAdmin: (groupId: string) => boolean;
  myPlayerIds: string[];
  dataVersion: number;
  invalidateData: () => void;
  isSelectedSeasonActive: boolean;
};

const GroupContext = createContext<GroupContextValue | null>(null);

export function GroupProvider({ children }: { children: React.ReactNode }) {
  const { signedIn, ready, userId } = useAuth();
  const [groups, setGroups] = useState<GroupWithSection[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<GroupWithSection | null>(null);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [selectedSeason, setSelectedSeason] = useState<Season | null>(null);
  // Loading state for the *groups list* fetch. Combined with the resolution
  // flags below to expose a single `loading` value to consumers — true until
  // the picker can render correctly.
  const [groupsLoading, setGroupsLoading] = useState(true);

  // group_id → group_members.joined_at (ISO timestamp). Drives myGroups order
  // and the default-group resolution. Single source of truth — the prior
  // version had a duplicate inline query inside loadGroups, which could
  // disagree with this state and resolve the default to the wrong group.
  const [myMembershipJoinedAt, setMyMembershipJoinedAt] = useState<Map<string, string>>(new Map());
  // True once the membership query has completed for the current user (or
  // returned empty for a no-membership user). Required for the default-group
  // resolution effect: empty-Map could mean "still loading" or "no
  // memberships" without this flag.
  const [myMembershipsLoaded, setMyMembershipsLoaded] = useState(false);

  // Persisted manual selection per user_id. Loaded asynchronously from
  // userPrefs when userId changes. The default-resolution effect waits on
  // persistedChoiceLoaded so a stored pick wins over auto-selection.
  const [persistedChoiceId, setPersistedChoiceId] = useState<string | null>(null);
  const [persistedChoiceLoaded, setPersistedChoiceLoaded] = useState(false);

  // Permissions
  const [dataVersion, setDataVersion] = useState(0);
  const invalidateData = useCallback(() => setDataVersion((v) => v + 1), []);

  // Is the selected season currently active (end_date >= today)?
  const today = new Date().toISOString().slice(0, 10);
  const isSelectedSeasonActive = selectedSeason ? selectedSeason.end_date >= today : false;

  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [adminGroupIds, setAdminGroupIds] = useState<Set<string>>(new Set());
  const [myPlayerIds, setMyPlayerIds] = useState<string[]>([]);

  const isGroupAdmin = useCallback((groupId: string) => adminGroupIds.has(groupId), [adminGroupIds]);

  // Groups the user is an active member of, ordered by group_members.joined_at
  // DESC (most-recently-joined first) with name as a stable tie-break. The
  // picker, the drawer's "My Groups" section, and the default-group resolver
  // all read from this list — newest membership first matches the new-invitee
  // expectation: a player added to a group lands on that group on next
  // sign-in.
  const myGroups = useMemo(() => {
    const filtered = groups.filter((g) => myMembershipJoinedAt.has(g.id));
    return [...filtered].sort((a, b) => {
      const ja = myMembershipJoinedAt.get(a.id) ?? '';
      const jb = myMembershipJoinedAt.get(b.id) ?? '';
      const cmp = jb.localeCompare(ja); // DESC: later ISO sorts first
      return cmp !== 0 ? cmp : a.name.localeCompare(b.name);
    });
  }, [groups, myMembershipJoinedAt]);

  // ─── Permissions + memberships ────────────────────────────────────────────
  // Loads super-admin status, my player IDs, and my group memberships
  // (joined_at + role). Sets myMembershipsLoaded=true at the end so the
  // default-resolution effect knows it's safe to pick.
  useEffect(() => {
    if (!ready || !signedIn) {
      setIsSuperAdmin(false);
      setAdminGroupIds(new Set());
      setMyPlayerIds([]);
      setMyMembershipJoinedAt(new Map());
      setMyMembershipsLoaded(false);
      return;
    }
    let cancelled = false;
    setMyMembershipsLoaded(false);
    (async () => {
      const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
      const token = await getStoredAccessToken();
      const anonKey = getSupabaseAnonKey();
      if (!base || !token) {
        if (!cancelled) setMyMembershipsLoaded(true);
        return;
      }
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: anonKey || token };
      try {
        // Super admin
        const saRes = await fetch(`${base}/rest/v1/rpc/am_i_super_admin`, { method: 'POST', headers, body: '{}' });
        if (!cancelled && saRes.ok) {
          const val = await saRes.json();
          setIsSuperAdmin(val === true);
        }

        // My player IDs
        const pidRes = await fetch(`${base}/rest/v1/rpc/get_my_player_ids`, { method: 'POST', headers, body: '{}' });
        if (!pidRes.ok) {
          if (!cancelled) setMyMembershipsLoaded(true);
          return;
        }
        const ids: string[] = await pidRes.json();
        if (cancelled) return;
        setMyPlayerIds(ids);

        if (ids.length === 0) {
          // No player records linked to this auth user. Mark loaded so the
          // resolution effect can fall through to the no-membership branch.
          setMyMembershipJoinedAt(new Map());
          setAdminGroupIds(new Set());
          setMyMembershipsLoaded(true);
          return;
        }

        const inList = ids.map((id) => `"${id}"`).join(',');
        const gmRes = await fetch(
          `${base}/rest/v1/group_members?player_id=in.(${inList})&is_active=eq.1&select=group_id,role,joined_at`,
          { headers: { Authorization: `Bearer ${token}`, apikey: anonKey || token } }
        );
        if (!gmRes.ok) {
          if (!cancelled) setMyMembershipsLoaded(true);
          return;
        }
        const rows: { group_id: string; role: string; joined_at: string }[] = await gmRes.json();
        if (cancelled) return;
        // Defensive: if a user has multiple players in the same group_id, keep
        // the EARLIEST joined_at (so myGroups orders by first-touch when a
        // player has duplicate-membership rows). The MOST-recent direction is
        // applied at sort time — see myGroups useMemo above.
        const joinedAt = new Map<string, string>();
        for (const r of rows) {
          const prev = joinedAt.get(r.group_id);
          if (!prev || r.joined_at.localeCompare(prev) < 0) joinedAt.set(r.group_id, r.joined_at);
        }
        setMyMembershipJoinedAt(joinedAt);
        setAdminGroupIds(new Set(rows.filter((r) => r.role === 'admin').map((r) => r.group_id)));
        setMyMembershipsLoaded(true);
      } catch {
        if (!cancelled) setMyMembershipsLoaded(true); // unblock on errors
      }
    })();
    return () => { cancelled = true; };
  }, [ready, signedIn]);

  // ─── Persisted choice loader ──────────────────────────────────────────────
  // userPrefs is async; load the persisted selectedGroupId for the current
  // user_id and store in state. Default-resolution waits on this.
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

  // ─── Groups + sections list ──────────────────────────────────────────────
  // Just fetches the lists. Default-group resolution moved out of here into
  // the dedicated effect below — that effect waits on memberships and
  // persisted-choice before picking, which avoids the wrong-group flash that
  // existed when this function did its own inline membership query.
  const loadGroups = useCallback(async () => {
    setGroupsLoading(true);
    try {
      const [g, s] = await Promise.all([listGroups(), listSections()]);
      const sectionMap = new Map(s.map((sec) => [sec.id, sec.name]));
      const enriched: GroupWithSection[] = g.map((grp) => ({
        ...grp,
        sectionName: grp.section_id ? sectionMap.get(grp.section_id) ?? undefined : undefined,
      }));
      setGroups(enriched);
      setSections(s);
    } catch {
      // silent
    } finally {
      setGroupsLoading(false);
    }
  }, []);

  // ─── Sign-in / sign-out trigger for loadGroups ───────────────────────────
  useEffect(() => {
    if (ready && signedIn) {
      loadGroups();
    } else if (ready && !signedIn) {
      setGroups([]);
      setSections([]);
      setSelectedGroup(null);
      setSeasons([]);
      setSelectedSeason(null);
      setGroupsLoading(false);
    }
  }, [ready, signedIn, loadGroups]);

  // ─── Default-group resolution ────────────────────────────────────────────
  // Runs once everything needed is ready. Resolution chain:
  //   1. Persisted manual selection (if still a valid member, or if the user
  //      has no memberships at all).
  //   2. Most-recently-joined of myGroups (myGroups is sorted DESC, so [0]).
  //   3. Alphabetical-first overall — fallback for the no-membership case
  //      (super admin / brand-new user with no group_members rows). We
  //      can't read joined_at for groups the user isn't in, so alphabetical
  //      is the only sensible tiebreak here.
  useEffect(() => {
    if (!ready || !signedIn) return;
    if (selectedGroup) return; // already chosen
    if (groupsLoading) return; // groups list still loading
    if (!myMembershipsLoaded) return; // memberships still loading
    if (!persistedChoiceLoaded) return; // persisted choice still loading
    if (groups.length === 0) return; // nothing to pick

    let chosen: GroupWithSection | undefined;

    // 1. Persisted manual selection
    if (persistedChoiceId) {
      const candidate = groups.find((g) => g.id === persistedChoiceId);
      if (
        candidate &&
        (myMembershipJoinedAt.has(candidate.id) || myMembershipJoinedAt.size === 0)
      ) {
        chosen = candidate;
      }
    }

    // 2. Most-recently-joined of myGroups
    if (!chosen) chosen = myGroups[0];

    // 3. Alphabetical-first overall
    if (!chosen) {
      chosen = [...groups].sort((a, b) => a.name.localeCompare(b.name))[0];
    }

    if (chosen) setSelectedGroup(chosen);
  }, [
    ready, signedIn,
    selectedGroup,
    groupsLoading, myMembershipsLoaded, persistedChoiceLoaded,
    groups, myGroups, myMembershipJoinedAt,
    persistedChoiceId,
  ]);

  // ─── Seasons (loaded when group changes) ──────────────────────────────────
  useEffect(() => {
    if (!selectedGroup) {
      setSeasons([]);
      setSelectedSeason(null);
      return;
    }
    let cancelled = false;
    listSeasons(selectedGroup.id)
      .then((s) => {
        if (cancelled) return;
        setSeasons(s);
        const today = new Date().toISOString().slice(0, 10);
        const current = s.find((sn) => sn.end_date >= today && sn.start_date <= today);
        if (current) {
          setSelectedSeason(current);
        } else {
          const sorted = [...s].sort((a, b) => b.start_date.localeCompare(a.start_date));
          setSelectedSeason(sorted[0] ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSeasons([]);
          setSelectedSeason(null);
        }
      });
    return () => { cancelled = true; };
  }, [selectedGroup?.id]);

  const selectGroup = useCallback((group: GroupWithSection) => {
    // Capture the previous selection BEFORE the state update so the
    // group_switch event has accurate from_group_id. The initial default-
    // selection effect uses setSelectedGroup directly (not selectGroup), so
    // this path is by construction user-initiated — but we still guard on
    // prev existing + being a different id to avoid logging redundant
    // "switches" if a UI ever re-selects the current group.
    const prev = selectedGroup;
    setSelectedGroup(group);
    setSelectedSeason(null); // resolved by the seasons effect
    if (userId) {
      void userPrefs.setItem(selectedGroupKey(userId), group.id);
      setPersistedChoiceId(group.id);
    }
    if (prev && prev.id !== group.id) {
      void logUserEvent('group_switch', {
        groupId: group.id,
        playerId: myPlayerIds[0] ?? null,
        metadata: { from_group_id: prev.id },
      });
    }
  }, [userId, selectedGroup, myPlayerIds]);

  const selectSeason = useCallback((season: Season) => {
    setSelectedSeason(season);
  }, []);

  // Combined loading state for consumers. True until everything that affects
  // which group should be shown is settled. Components show a spinner instead
  // of rendering with a wrong-group flash followed by correction.
  const loading =
    groupsLoading ||
    !myMembershipsLoaded ||
    !persistedChoiceLoaded ||
    (signedIn && groups.length > 0 && !selectedGroup);

  return (
    <GroupContext.Provider
      value={{
        groups,
        myGroups,
        sections,
        selectedGroup,
        selectedSeason,
        seasons,
        selectGroup,
        selectSeason,
        loading,
        seasonLabel: getSeasonLabel,
        reload: loadGroups,
        isSuperAdmin,
        isGroupAdmin,
        myPlayerIds,
        dataVersion,
        invalidateData,
        isSelectedSeasonActive,
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
