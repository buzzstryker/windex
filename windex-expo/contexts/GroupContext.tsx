import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  listGroups,
  listSeasons,
  listSections,
  getStoredAccessToken,
  seasonLabel as getSeasonLabel,
  type Group,
  type Season,
  type Section,
} from '@/lib/api';
import { getApiBase, getSupabaseAnonKey } from '@/lib/config';
import { useAuth } from '@/contexts/AuthContext';
import { selectedGroupKey, userPrefs } from '@/lib/userPrefs';

type GroupWithSection = Group & { sectionName?: string };

type GroupContextValue = {
  groups: GroupWithSection[];
  /** Groups the current user is an active member of, sorted by group_members.joined_at ASC (earliest first). */
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
  const [loading, setLoading] = useState(true);
  // group_id → group_members.joined_at (ISO timestamp). Drives myGroups order
  // and the default-group fallback chain.
  const [myMembershipJoinedAt, setMyMembershipJoinedAt] = useState<Map<string, string>>(new Map());

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
  // ASC (earliest membership first). The picker, the drawer's "My Groups"
  // section, and the default-group fallback all read from this list.
  const myGroups = useMemo(() => {
    const filtered = groups.filter((g) => myMembershipJoinedAt.has(g.id));
    return [...filtered].sort((a, b) => {
      const ja = myMembershipJoinedAt.get(a.id) ?? '';
      const jb = myMembershipJoinedAt.get(b.id) ?? '';
      // ISO-8601 sorts lexicographically; tie-break by name for stable order.
      const cmp = ja.localeCompare(jb);
      return cmp !== 0 ? cmp : a.name.localeCompare(b.name);
    });
  }, [groups, myMembershipJoinedAt]);

  // Load permissions after sign-in
  useEffect(() => {
    if (!ready || !signedIn) {
      setIsSuperAdmin(false);
      setAdminGroupIds(new Set());
      setMyPlayerIds([]);
      setMyMembershipJoinedAt(new Map());
      return;
    }
    (async () => {
      const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
      const token = await getStoredAccessToken();
      const anonKey = getSupabaseAnonKey();
      if (!base || !token) return;
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: anonKey || token };
      try {
        // Check super admin
        const saRes = await fetch(`${base}/rest/v1/rpc/am_i_super_admin`, { method: 'POST', headers, body: '{}' });
        if (saRes.ok) { const val = await saRes.json(); setIsSuperAdmin(val === true); }

        // Get my player IDs
        const pidRes = await fetch(`${base}/rest/v1/rpc/get_my_player_ids`, { method: 'POST', headers, body: '{}' });
        if (pidRes.ok) {
          const ids: string[] = await pidRes.json();
          setMyPlayerIds(ids);

          // Find my group memberships (active) — used by both the picker and drawer.
          // joined_at drives myGroups order; role identifies admin memberships.
          if (ids.length > 0) {
            const inList = ids.map((id) => `"${id}"`).join(',');
            const gmRes = await fetch(
              `${base}/rest/v1/group_members?player_id=in.(${inList})&is_active=eq.1&select=group_id,role,joined_at`,
              { headers: { Authorization: `Bearer ${token}`, apikey: anonKey || token } }
            );
            if (gmRes.ok) {
              const rows: { group_id: string; role: string; joined_at: string }[] = await gmRes.json();
              // If a player has multiple membership rows for the same group_id
              // (shouldn't happen given the UNIQUE constraint on (group_id,
              // player_id), but the user can have multiple players), keep the
              // earliest joined_at so myGroups reflects first-touch order.
              const joinedAt = new Map<string, string>();
              for (const r of rows) {
                const prev = joinedAt.get(r.group_id);
                if (!prev || r.joined_at.localeCompare(prev) < 0) joinedAt.set(r.group_id, r.joined_at);
              }
              setMyMembershipJoinedAt(joinedAt);
              setAdminGroupIds(new Set(rows.filter((r) => r.role === 'admin').map((r) => r.group_id)));
            }
          } else {
            setMyMembershipJoinedAt(new Map());
            setAdminGroupIds(new Set());
          }
        }
      } catch {
        // silent
      }
    })();
  }, [ready, signedIn]);

  const loadGroups = useCallback(async () => {
    setLoading(true);
    try {
      const [g, s] = await Promise.all([listGroups(), listSections()]);
      const sectionMap = new Map(s.map((sec) => [sec.id, sec.name]));
      const enriched: GroupWithSection[] = g.map((grp) => ({
        ...grp,
        sectionName: grp.section_id ? sectionMap.get(grp.section_id) ?? undefined : undefined,
      }));
      setGroups(enriched);
      setSections(s);

      // Auto-select default group:
      //   1. Persisted manual selection (per user_id) if still a valid membership.
      //   2. Earliest-joined of the user's active group memberships
      //      (group_members.joined_at ASC).
      //   3. Earliest-joined overall — i.e. the group with the smallest
      //      joined_at across all rows the user can see, used when the user
      //      has no memberships (e.g. super admin browsing).
      if (!selectedGroup && enriched.length > 0) {
        let memberJoinedAt: Map<string, string> | null = null;
        try {
          const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
          const token = await getStoredAccessToken();
          const anonKey = getSupabaseAnonKey() || '';
          const headers = { Authorization: `Bearer ${token}`, apikey: anonKey || token || '' };
          if (base && token) {
            const pidRes = await fetch(`${base}/rest/v1/rpc/get_my_player_ids`, {
              method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}',
            });
            if (pidRes.ok) {
              const ids: string[] = await pidRes.json();
              if (ids.length > 0) {
                const inList = ids.map((id) => `"${id}"`).join(',');
                const gmRes = await fetch(
                  `${base}/rest/v1/group_members?player_id=in.(${inList})&is_active=eq.1&select=group_id,joined_at`,
                  { headers },
                );
                if (gmRes.ok) {
                  const rows: { group_id: string; joined_at: string }[] = await gmRes.json();
                  memberJoinedAt = new Map();
                  for (const r of rows) {
                    const prev = memberJoinedAt.get(r.group_id);
                    if (!prev || r.joined_at.localeCompare(prev) < 0) memberJoinedAt.set(r.group_id, r.joined_at);
                  }
                }
              }
            }
          }
        } catch {
          // silent — we'll fall through to the alphabetical-by-name tie-break
          // inside the comparator below
        }

        const cmpName = (a: GroupWithSection, b: GroupWithSection) => a.name.localeCompare(b.name);
        const earliestMine = memberJoinedAt
          ? [...enriched]
              .filter((grp) => memberJoinedAt!.has(grp.id))
              .sort((a, b) => {
                const cmp = (memberJoinedAt!.get(a.id) ?? '').localeCompare(memberJoinedAt!.get(b.id) ?? '');
                return cmp !== 0 ? cmp : cmpName(a, b);
              })
          : [];
        // For "earliest overall" we don't have joined_at for every group
        // (only for memberships). For the no-membership case (super admin /
        // brand-new user), fall back to alphabetical — there's no join row
        // to read order from.
        const earliestAll = [...enriched].sort(cmpName);

        // 1. Persisted manual selection wins.
        let chosen: GroupWithSection | undefined;
        if (userId) {
          try {
            const persisted = await userPrefs.getItem(selectedGroupKey(userId));
            if (persisted) {
              const candidate = enriched.find((grp) => grp.id === persisted);
              // Honor persisted choice if it's still a member group, or if the
              // user has no memberships at all (e.g. super admin).
              if (candidate && (!memberJoinedAt || memberJoinedAt.has(candidate.id) || memberJoinedAt.size === 0)) {
                chosen = candidate;
              }
            }
          } catch {
            // ignore
          }
        }

        // 2. Earliest-joined of my groups.
        if (!chosen) chosen = earliestMine[0];
        // 3. Earliest-joined overall (alphabetical fallback — see above).
        if (!chosen) chosen = earliestAll[0];

        if (chosen) setSelectedGroup(chosen);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load seasons when group changes
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
        // Auto-select current season: end_date >= today, or most recent
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

  useEffect(() => {
    if (ready && signedIn) {
      loadGroups();
    } else if (ready && !signedIn) {
      setGroups([]);
      setSections([]);
      setSelectedGroup(null);
      setSeasons([]);
      setSelectedSeason(null);
      setLoading(false);
    }
  }, [ready, signedIn, loadGroups]);

  const selectGroup = useCallback((group: GroupWithSection) => {
    setSelectedGroup(group);
    setSelectedSeason(null); // will be resolved by the useEffect above
    // Persist manual selection per user_id so it survives reloads.
    if (userId) {
      void userPrefs.setItem(selectedGroupKey(userId), group.id);
    }
  }, [userId]);

  const selectSeason = useCallback((season: Season) => {
    setSelectedSeason(season);
  }, []);

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
