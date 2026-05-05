import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  listGroups,
  listSeasons,
  listSections,
  listEvents,
  getStoredAccessToken,
  seasonLabel as getSeasonLabel,
  type Group,
  type Season,
  type Section,
} from '@/lib/api';
import { getApiBase, getSupabaseAnonKey } from '@/lib/config';
import { useAuth } from '@/contexts/AuthContext';

type GroupWithSection = Group & { sectionName?: string };

type GroupContextValue = {
  groups: GroupWithSection[];
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
  const { signedIn, ready } = useAuth();
  const [groups, setGroups] = useState<GroupWithSection[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<GroupWithSection | null>(null);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [selectedSeason, setSelectedSeason] = useState<Season | null>(null);
  const [loading, setLoading] = useState(true);

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

  // Load permissions after sign-in
  useEffect(() => {
    if (!ready || !signedIn) {
      setIsSuperAdmin(false);
      setAdminGroupIds(new Set());
      setMyPlayerIds([]);
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

          // Find which groups I'm admin of
          if (ids.length > 0) {
            const inList = ids.map((id) => `"${id}"`).join(',');
            const gmRes = await fetch(
              `${base}/rest/v1/group_members?player_id=in.(${inList})&role=eq.admin&select=group_id`,
              { headers: { Authorization: `Bearer ${token}`, apikey: anonKey || token } }
            );
            if (gmRes.ok) {
              const rows: { group_id: string }[] = await gmRes.json();
              setAdminGroupIds(new Set(rows.map((r) => r.group_id)));
            }
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

      // Auto-select: find the group the player most recently played in
      if (!selectedGroup && enriched.length > 0) {
        let myGroupIds: Set<string> | null = null;
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
                  `${base}/rest/v1/group_members?player_id=in.(${inList})&is_active=eq.1&select=group_id`,
                  { headers },
                );
                if (gmRes.ok) {
                  const rows: { group_id: string }[] = await gmRes.json();
                  myGroupIds = new Set(rows.map((r) => r.group_id));
                }
              }
            }
          }

          // Find most recent round, preferring groups the player belongs to
          const events = await listEvents({});
          if (events.length > 0) {
            const sorted = [...events].sort((a, b) => b.round_date.localeCompare(a.round_date));
            // Prefer a round from a group the player is in
            const myEvent = myGroupIds
              ? sorted.find((e) => myGroupIds!.has(e.group_id))
              : null;
            const bestGroupId = myEvent?.group_id ?? sorted[0].group_id;
            const match = enriched.find((grp) => grp.id === bestGroupId);
            setSelectedGroup(match ?? enriched[0]);
          } else {
            // No events — pick first group the player belongs to
            const myGroup = myGroupIds
              ? enriched.find((g) => myGroupIds!.has(g.id))
              : null;
            setSelectedGroup(myGroup ?? enriched[0]);
          }
        } catch {
          // Even if events fetch fails, prefer a group the player belongs to
          const fallback = myGroupIds
            ? enriched.find((g) => myGroupIds!.has(g.id))
            : null;
          setSelectedGroup(fallback ?? enriched[0]);
        }
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, []);

  const selectSeason = useCallback((season: Season) => {
    setSelectedSeason(season);
  }, []);

  return (
    <GroupContext.Provider
      value={{
        groups,
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
