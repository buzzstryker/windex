/**
 * Leaderboard data: cache keys, query options, and the fetchers behind them.
 *
 * Each fetcher calls its migration-061 RPC. If the RPC fails for any reason
 * other than auth (not deployed yet, 5xx, network), it falls back to the
 * pre-061 calls — groups -> seasons -> get-standings, plus the events count —
 * and returns the same shape. The fallback is for the first release only;
 * remove it in the edge-function cleanup step (Phase 2 spec, rollout step 8).
 *
 * Every key starts with the auth user id so one user's cache is never shown to
 * another on a shared device. Payloads are cached whole: a season entry holds
 * its standings AND its match count, so the pill and the table share one entry.
 */
import {
  ApiError,
  getAllTimeStandings,
  getLeaderboardBootstrap,
  getSeasonStandings,
  getStandings,
  getStoredAccessToken,
  listEvents,
  listGroups,
  listSeasons,
  listSections,
  type AllTimeStandings,
  type BootstrapMe,
  type LeaderboardBootstrap,
  type Season,
  type SeasonStandingsPayload,
  type StandingRow,
} from '@/lib/api';
import { getApiBase, getSupabaseAnonKey } from '@/lib/config';
import { OPEN_MAX_AGE_MS } from '@/lib/queryClient';

// ─── Keys ───────────────────────────────────────────────────────────────────

export const leaderboardKeys = {
  bootstrap: (userId: string, groupId: string | null) => ['bootstrap', userId, groupId] as const,
  season: (userId: string, groupId: string, seasonId: string) => ['season', userId, groupId, seasonId] as const,
  allTime: (userId: string, groupId: string) => ['allTime', userId, groupId] as const,
};

/** Open seasons revalidate after 30 s; a closed season's snapshot never does. */
export function seasonQueryOptions(closed: boolean) {
  return closed
    ? { staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false }
    : { staleTime: 30_000, gcTime: OPEN_MAX_AGE_MS };
}

export const BOOTSTRAP_STALE_MS = 30_000;
export const ALL_TIME_STALE_MS = 5 * 60_000;

// ─── Fallback policy ────────────────────────────────────────────────────────

/** Auth failures are real answers; anything else may just mean 061 isn't live. */
function shouldFallBack(e: unknown): boolean {
  return !(e instanceof ApiError && (e.status === 401 || e.status === 403));
}

function warnFallback(rpc: string, e: unknown): void {
  console.warn(`${rpc} failed; using the pre-061 calls this load:`, e instanceof Error ? e.message : e);
}

// ─── Season ─────────────────────────────────────────────────────────────────

async function legacySeasonStandings(groupId: string, seasonId: string): Promise<SeasonStandingsPayload> {
  const [standings, events] = await Promise.all([
    getStandings(seasonId, groupId),
    listEvents({ group_id: groupId, season_id: seasonId }),
  ]);
  return {
    season_id: seasonId,
    group_id: groupId,
    closed_at: null,
    source: 'live',
    match_count: events.length,
    standings,
    as_of: new Date().toISOString(),
  };
}

export async function fetchSeasonStandings(groupId: string, seasonId: string): Promise<SeasonStandingsPayload> {
  try {
    return await getSeasonStandings(groupId, seasonId);
  } catch (e) {
    if (!shouldFallBack(e)) throw e;
    warnFallback('get_season_standings', e);
    return legacySeasonStandings(groupId, seasonId);
  }
}

// ─── All Time ───────────────────────────────────────────────────────────────

/** The pre-061 loop: one get-standings per season, merged per player. */
async function legacyAllTime(groupId: string, seasons: Season[]): Promise<AllTimeStandings> {
  const allRows: StandingRow[] = [];
  for (const s of seasons) {
    const rows = await getStandings(s.id, groupId);
    allRows.push(...rows);
  }
  const merged = new Map<string, StandingRow>();
  for (const row of allRows) {
    const existing = merged.get(row.player_id);
    if (existing) {
      existing.total_points += row.total_points;
      existing.rounds_played += row.rounds_played;
      existing.wins += row.wins;
      existing.losses += row.losses;
      existing.ties += row.ties;
    } else {
      merged.set(row.player_id, { ...row });
    }
  }
  const sorted = [...merged.values()].sort((a, b) => b.total_points - a.total_points);
  sorted.forEach((row, i) => { row.rank = i + 1; });
  return {
    group_id: groupId,
    closed_seasons: [],
    open_seasons: seasons.map((s) => s.id),
    standings: sorted,
    as_of: new Date().toISOString(),
  };
}

export async function fetchAllTime(groupId: string, seasons: Season[]): Promise<AllTimeStandings> {
  try {
    return await getAllTimeStandings(groupId);
  } catch (e) {
    if (!shouldFallBack(e)) throw e;
    warnFallback('get_all_time_standings', e);
    return legacyAllTime(groupId, seasons);
  }
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

/**
 * The pre-061 app-open chain, assembled into the bootstrap shape: the identity
 * lookups GroupContext used to make (am_i_super_admin, players, group_members),
 * then groups + sections, seasons, and the selected season's standings + count.
 * Group and season resolution mirror get_leaderboard_bootstrap.
 */
async function legacyBootstrap(userId: string, requestedGroupId: string | null): Promise<LeaderboardBootstrap> {
  const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
  const token = await getStoredAccessToken();
  if (!base || !token) throw new ApiError(401, 'Sign in first');
  const anonKey = getSupabaseAnonKey();
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: anonKey || token };

  const identity = async (): Promise<BootstrapMe> => {
    const saRes = await fetch(`${base}/rest/v1/rpc/am_i_super_admin`, { method: 'POST', headers, body: '{}' });
    const isSuperAdmin = saRes.ok ? (await saRes.json()) === true : false;
    const pidRes = await fetch(
      `${base}/rest/v1/players?user_id=eq.${encodeURIComponent(userId)}` +
        `&select=id,is_heckler,display_name,email&order=created_at.asc`,
      { headers },
    );
    const playerRows: { id: string; is_heckler: boolean | null; display_name: string | null; email: string | null }[] =
      pidRes.ok ? await pidRes.json() : [];
    const ids = playerRows.map((r) => r.id);
    let memberships: BootstrapMe['memberships'] = [];
    if (ids.length > 0) {
      const inList = ids.map((id) => `"${id}"`).join(',');
      const gmRes = await fetch(
        `${base}/rest/v1/group_members?player_id=in.(${inList})&is_active=eq.1&select=group_id,role,joined_at`,
        { headers },
      );
      const rows: { group_id: string; role: string; joined_at: string }[] = gmRes.ok ? await gmRes.json() : [];
      const byGroup = new Map<string, { joined_at: string; is_admin: boolean }>();
      for (const r of rows) {
        const prev = byGroup.get(r.group_id);
        byGroup.set(r.group_id, {
          joined_at: !prev || r.joined_at.localeCompare(prev.joined_at) < 0 ? r.joined_at : prev.joined_at,
          is_admin: (prev?.is_admin ?? false) || r.role === 'admin',
        });
      }
      memberships = [...byGroup.entries()]
        .map(([group_id, v]) => ({ group_id, ...v }))
        .sort((a, b) => b.joined_at.localeCompare(a.joined_at));
    }
    return {
      user_id: userId,
      player_ids: ids,
      display_name: playerRows[0]?.display_name ?? null,
      email: playerRows[0]?.email ?? null,
      is_heckler: playerRows.some((r) => r.is_heckler === true),
      is_super_admin: isSuperAdmin,
      memberships,
    };
  };

  const [me, groups, sections] = await Promise.all([identity(), listGroups(), listSections()]);
  const sectionNames = new Map(sections.map((s) => [s.id, s.name]));
  const leagues = groups.filter((g) => g.group_type !== 'roster');

  const memberLeagues = me.memberships
    .map((m) => ({ m, g: leagues.find((g) => g.id === m.group_id) }))
    .filter((x) => !!x.g)
    .sort((a, b) => b.m.joined_at.localeCompare(a.m.joined_at) || a.g!.name.localeCompare(b.g!.name));
  const selectedGroup =
    leagues.find((g) => g.id === requestedGroupId) ??
    memberLeagues[0]?.g ??
    [...leagues].sort((a, b) => a.name.localeCompare(b.name))[0] ??
    null;

  let seasons: Season[] = [];
  let selectedSeasonId: string | null = null;
  let selectedSeason: SeasonStandingsPayload | null = null;
  if (selectedGroup) {
    seasons = await listSeasons(selectedGroup.id); // already filtered to started seasons
    const today = new Date().toISOString().slice(0, 10);
    const newestFirst = [...seasons].sort((a, b) => b.start_date.localeCompare(a.start_date));
    const pick = newestFirst.find((s) => s.end_date >= today) ?? newestFirst[0] ?? null;
    if (pick) {
      selectedSeasonId = pick.id;
      selectedSeason = await legacySeasonStandings(selectedGroup.id, pick.id);
    }
    seasons = newestFirst;
  }

  return {
    me,
    groups: groups.map((g) => ({ ...g, section_name: g.section_id ? sectionNames.get(g.section_id) ?? null : null })),
    selected_group_id: selectedGroup?.id ?? null,
    seasons,
    selected_season_id: selectedSeasonId,
    selected_season: selectedSeason,
    as_of: new Date().toISOString(),
  };
}

export async function fetchBootstrap(userId: string, requestedGroupId: string | null): Promise<LeaderboardBootstrap> {
  try {
    return await getLeaderboardBootstrap(requestedGroupId);
  } catch (e) {
    if (!shouldFallBack(e)) throw e;
    warnFallback('get_leaderboard_bootstrap', e);
    return legacyBootstrap(userId, requestedGroupId);
  }
}
