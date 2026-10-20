import { apiFetch, getAuthToken } from './client';
import type { StandingRow, PlayerStandingsHistoryResponse } from '../types';

const SUPABASE_URL = (
  typeof import.meta.env !== 'undefined' && import.meta.env.VITE_LATE_ADD_API_URL
    ? import.meta.env.VITE_LATE_ADD_API_URL
    : 'https://ftmqzxykwcccocogkjhc.supabase.co/functions/v1'
).replace(/\/functions\/v1\/?$/, '');

const ANON_KEY =
  typeof import.meta.env !== 'undefined' && import.meta.env.VITE_SUPABASE_ANON_KEY
    ? import.meta.env.VITE_SUPABASE_ANON_KEY
    : null;

export type SeasonStandings = {
  rows: StandingRow[];
  /** 'final' = frozen snapshot of a closed season (migration 059); 'live' = computed now. */
  source: 'live' | 'final';
};

/**
 * One season's standings as players see them: get_season_standings (migration
 * 061) returns the frozen snapshot for a closed season and live rows otherwise.
 * Falls back to GET /get-standings (always live) if the RPC is unavailable —
 * e.g. before 061 is applied — or when no group is selected (the RPC needs one).
 */
export async function getSeasonStandings(seasonId: string, groupId?: string): Promise<SeasonStandings> {
  if (groupId) {
    try {
      const token = getAuthToken() ?? ANON_KEY;
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_season_standings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(ANON_KEY ? { apikey: ANON_KEY } : {}),
        },
        body: JSON.stringify({ p_group_id: groupId, p_season_id: seasonId }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          source: 'live' | 'final';
          standings: Omit<StandingRow, 'season_id' | 'group_id'>[];
        };
        return {
          source: data.source,
          rows: data.standings.map((r) => ({ ...r, season_id: seasonId, group_id: groupId })),
        };
      }
    } catch {
      /* fall through to the edge function */
    }
  }
  return { source: 'live', rows: await getStandings(seasonId, groupId) };
}

/**
 * Get standings by season (and optional group). Uses documented GET /get-standings.
 */
export async function getStandings(seasonId: string, groupId?: string): Promise<StandingRow[]> {
  const params = new URLSearchParams({ season_id: seasonId });
  if (groupId) params.set('group_id', groupId);
  const data = await apiFetch<{ standings: StandingRow[] }>(`/get-standings?${params.toString()}`);
  const list = data.standings ?? [];
  return list.map((row, i) => ({ ...row, rank: i + 1 }));
}

/**
 * Get point history for one player in a group/season (ledger drilldown).
 * GET /standings-player-history?group_id=&season_id=&player_id=
 */
export async function getPlayerStandingsHistory(
  groupId: string,
  seasonId: string,
  playerId: string
): Promise<PlayerStandingsHistoryResponse> {
  const params = new URLSearchParams({ group_id: groupId, season_id: seasonId, player_id: playerId });
  return apiFetch<PlayerStandingsHistoryResponse>(`/standings-player-history?${params.toString()}`);
}
