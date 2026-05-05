import { apiFetch } from './client';
import type { StandingRow, PlayerStandingsHistoryResponse } from '../types';

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
