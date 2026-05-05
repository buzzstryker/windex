import { apiFetch } from './client';

// ── Matrix: all-vs-all differential ──

export interface MatrixCell {
  net: number; // A's points - B's points in shared rounds
  rounds: number;
}

export interface MatrixResult {
  playerIds: string[];
  playerNames: Record<string, string>;
  cells: Record<string, Record<string, MatrixCell>>; // cells[a][b]
}

// Response shape from the GET /get-points-matrix Edge Function
interface EdgeMatrixResponse {
  group_id: string;
  season_id: string | null;
  exclude_signature_events: boolean;
  players: { id: string; display_name: string }[];
  cells: Record<string, Record<string, { net: number; rounds: number }>>;
  matchups: { player_a: string; player_b: string; net: number; rounds: number; avg_per_round: number }[];
}

export async function getMatrix(
  groupId: string,
  seasonId: string | null,
  playerNames: Record<string, string>,
  _activePlayerIds?: Set<string>,
  _allowedSeasonIds?: Set<string>,
  excludeSigEvents = false
): Promise<MatrixResult> {
  const params = new URLSearchParams({ group_id: groupId });
  if (seasonId) {
    params.set('season_id', seasonId);
  }
  if (excludeSigEvents) {
    params.set('exclude_signature_events', 'true');
  }

  const data = await apiFetch<EdgeMatrixResponse>(
    `/get-points-matrix?${params.toString()}`
  );

  // Build playerNames map from the server response, merging with caller-provided names
  const names: Record<string, string> = { ...playerNames };
  for (const p of data.players) {
    if (!names[p.id]) {
      names[p.id] = p.display_name;
    }
  }

  // Use the cells directly from the server response
  const cells: Record<string, Record<string, MatrixCell>> = data.cells;

  // Collect player IDs that appear in the matrix
  const playerIdSet = new Set<string>(data.players.map((p) => p.id));

  // Sort players by total net points descending (strongest first)
  const playerIds = [...playerIdSet].sort((a, b) => {
    const totalA = Object.values(cells[a] ?? {}).reduce((s, c) => s + c.net, 0);
    const totalB = Object.values(cells[b] ?? {}).reduce((s, c) => s + c.net, 0);
    return totalB - totalA;
  });

  return { playerIds, playerNames: names, cells };
}

/** No-op kept for backward compatibility with callers that still call it. */
export function invalidateCache() {
  // Server-side computation — nothing to invalidate client-side.
}

// ── Head-to-head detail ──

export interface HeadToHeadRound {
  round_date: string;
  season_id: string | null;
  pointsA: number;
  pointsB: number;
}

export interface SeasonSummary {
  season_id: string | null;
  seasonYear: string;
  rounds: number;
  totalA: number;
  totalB: number;
  net: number;
  winsA: number;
  winsB: number;
  ties: number;
}

export interface HeadToHeadResult {
  rounds: HeadToHeadRound[];
  seasons: SeasonSummary[];
  totalRounds: number;
  totalNetA: number;
  winsA: number;
  winsB: number;
  ties: number;
}

// ── Edge Function response types ──

interface EdgeRoundDetail {
  league_round_id: string;
  round_date: string;
  player_a_points: number;
  player_b_points: number;
  net: number;
}

interface EdgeSeasonBlock {
  season_id: string;
  season_name: string;
  rounds_together: number;
  player_a_total_points: number;
  player_b_total_points: number;
  net_points: number;
  player_a_wins: number;
  player_b_wins: number;
  ties: number;
  rounds: EdgeRoundDetail[];
}

interface EdgePointsAnalysis {
  group_id: string;
  player_a: { id: string; display_name: string };
  player_b: { id: string; display_name: string };
  lifetime: {
    rounds_together: number;
    player_a_total_points: number;
    player_b_total_points: number;
    net_points: number;
    player_a_wins: number;
    player_b_wins: number;
    ties: number;
  };
  by_season: EdgeSeasonBlock[];
}

export async function getHeadToHead(
  groupId: string,
  playerA: string,
  playerB: string,
  _allowedSeasonIds?: Set<string>,
  excludeSigEvents = true
): Promise<HeadToHeadResult> {
  const params = new URLSearchParams({
    group_id: groupId,
    player_a_id: playerA,
    player_b_id: playerB,
    exclude_signature_events: String(excludeSigEvents),
  });

  const data = await apiFetch<EdgePointsAnalysis>(
    `/get-points-analysis?${params.toString()}`
  );

  // Flatten all rounds from every season into HeadToHeadRound[]
  const h2hRounds: HeadToHeadRound[] = [];
  for (const season of data.by_season) {
    for (const r of season.rounds) {
      h2hRounds.push({
        round_date: r.round_date,
        season_id: season.season_id,
        pointsA: r.player_a_points,
        pointsB: r.player_b_points,
      });
    }
  }
  h2hRounds.sort((a, b) => a.round_date.localeCompare(b.round_date));

  // Map each season block to SeasonSummary
  const seasons: SeasonSummary[] = data.by_season.map((s) => {
    // Derive a display year from the season's round dates
    const dates = s.rounds.map((r) => r.round_date).sort();
    const mid = dates[Math.floor(dates.length / 2)];
    return {
      season_id: s.season_id,
      seasonYear: mid ? mid.slice(0, 4) : '—',
      rounds: s.rounds_together,
      totalA: Math.round(s.player_a_total_points),
      totalB: Math.round(s.player_b_total_points),
      net: Math.round(s.net_points),
      winsA: s.player_a_wins,
      winsB: s.player_b_wins,
      ties: s.ties,
    };
  });
  seasons.sort((a, b) => a.seasonYear.localeCompare(b.seasonYear));

  return {
    rounds: h2hRounds,
    seasons,
    totalRounds: data.lifetime.rounds_together,
    totalNetA: Math.round(data.lifetime.net_points),
    winsA: data.lifetime.player_a_wins,
    winsB: data.lifetime.player_b_wins,
    ties: data.lifetime.ties,
  };
}
