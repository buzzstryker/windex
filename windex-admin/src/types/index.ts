/** Event (league_round) as returned by API or list. */
export interface EventSummary {
  id: string;
  external_event_id?: string | null;
  source_app?: string | null;
  round_date: string;
  group_id: string;
  group_name?: string;
  season_id?: string | null;
  season_name?: string | null;
  status: EventStatus;
  unresolved_player_count?: number;
  attribution_status?: string;
  created_at: string;
  updated_at?: string;
  is_signature_event?: number;
  total_game_points?: number;
}

export type EventStatus =
  | 'processed'
  | 'partial_unresolved_players'
  | 'pending_attribution'
  | 'pending_player_mapping'
  | 'validation_error'
  | 'duplicate_ignored';

/** Event detail including results (league_scores). */
export interface EventDetail extends EventSummary {
  results?: EventResult[];
  attribution_status?: string;
  validation_errors?: string[];
  mapping_issues?: string[];
}

export interface EventResult {
  player_id: string;
  player_name?: string;
  score_value: number;
  score_override?: number | null;
  game_points?: number | null;
  result_type?: 'win' | 'loss' | 'tie' | null;
  override_reason?: string | null;
  override_actor?: string | null;
  override_at?: string | null;
}

/** Standings row from get-standings. */
export interface StandingRow {
  season_id: string;
  group_id: string;
  player_id: string;
  player_name?: string;
  rounds_played: number;
  total_points: number;
  rank?: number;
}

/** One round-level point record for player standings history (ledger drilldown). */
export interface PlayerStandingsHistoryRow {
  event_id: string;
  round_date: string;
  effective_points: number;
  score_value: number | null;
  score_override: number | null;
  override_reason?: string | null;
  override_actor?: string | null;
  override_at?: string | null;
  source_app: string | null;
  processing_status: string | null;
  attribution_status: string | null;
}

/** Response from GET standings-player-history. */
export interface PlayerStandingsHistoryResponse {
  player_id: string;
  player_name: string | null;
  total_points: number;
  rounds_played: number;
  history: PlayerStandingsHistoryRow[];
}

/** Canonical player (from GET /players). */
export interface Player {
  id: string;
  display_name: string;
  is_active?: number;
}

/** Group (league unit). */
export interface Group {
  id: string;
  name: string;
  section_id?: string | null;
}

/** Season. */
export interface Season {
  id: string;
  group_id: string;
  name?: string;
  start_date: string;
  end_date: string;
}

/**
 * Display label for a season: the year in which most of the season falls.
 * e.g. a season starting Dec 1 2022 → "2023"
 */
export function seasonLabel(s: Season): string {
  if (s.name) return s.name;
  if (!s.start_date) return s.id.slice(0, 8);
  const start = new Date(s.start_date + 'T00:00:00');
  const end = s.end_date ? new Date(s.end_date + 'T00:00:00') : start;
  const mid = new Date((start.getTime() + end.getTime()) / 2);
  return String(mid.getFullYear());
}

/**
 * Convert a season_name string like "2023-12-01 – 2024-11-30" to its year label.
 * Returns the input unchanged if it doesn't match the date-range pattern.
 */
export function seasonNameToYear(name: string | null | undefined): string {
  if (!name) return '—';
  const m = name.match(/^(\d{4}-\d{2}-\d{2})\s*[–-]\s*(\d{4}-\d{2}-\d{2})$/);
  if (!m) return name;
  const start = new Date(m[1] + 'T00:00:00');
  const end = new Date(m[2] + 'T00:00:00');
  const mid = new Date((start.getTime() + end.getTime()) / 2);
  return String(mid.getFullYear());
}

/** Attribution review item. */
export interface AttributionItem {
  id: string;
  event_id: string;
  source_app?: string | null;
  round_date: string;
  status: string;
  group_id?: string | null;
  season_id?: string | null;
  candidate_groups?: Group[];
  candidate_seasons?: Season[];
  event_metadata?: Record<string, unknown>;
  results?: EventResult[];
}

/** Player mapping item (unmapped source player). */
export interface PlayerMappingItem {
  id: string;
  source_player_name: string;
  source_app?: string | null;
  related_event_id?: string;
  related_event_date?: string;
  status: string;
  candidate_players?: { id: string; name: string }[];
}

/** Ingest request body (manual or API). */
export interface IngestEventRequest {
  group_id: string;
  season_id?: string | null;
  round_date: string;
  source_app?: string | null;
  external_event_id?: string | null;
  scores: { player_id: string; score_value?: number; result_type?: 'win' | 'loss' | 'tie' }[];
}
