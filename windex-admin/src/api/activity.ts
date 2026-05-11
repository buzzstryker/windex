import { getAuthToken } from './client';

const SUPABASE_URL = (
  typeof import.meta.env !== 'undefined' && import.meta.env.VITE_LATE_ADD_API_URL
    ? import.meta.env.VITE_LATE_ADD_API_URL
    : 'https://ftmqzxykwcccocogkjhc.supabase.co/functions/v1'
).replace(/\/functions\/v1\/?$/, '');

const ANON_KEY =
  typeof import.meta.env !== 'undefined' && import.meta.env.VITE_SUPABASE_ANON_KEY
    ? import.meta.env.VITE_SUPABASE_ANON_KEY
    : null;

function headers(extra?: Record<string, string>): Record<string, string> {
  const token = getAuthToken() ?? ANON_KEY;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(ANON_KEY ? { apikey: ANON_KEY } : {}),
    ...extra,
  };
}

/**
 * RPC: get_players_with_last_activity()
 *
 * One row per player from public.players, LEFT JOINed to their most-recent
 * activity_events entry. Sorted by last_event_at DESC NULLS LAST, then
 * display_name ASC (per the App Activity tab spec).
 *
 * Non-super-admin callers see `last_event_at = null` for every row
 * (activity_events RLS gates SELECT to super admins; the underlying view
 * is `security_invoker = true` so the gate applies through the function).
 * The Activity page additionally gates its render on `isCurrentUserSuperAdmin()`.
 */
export interface PlayerWithLastActivity {
  player_id: string;
  display_name: string;
  email: string | null;
  last_event_at: string | null;
  last_event_type: string | null;
}

export async function getPlayersWithLastActivity(): Promise<PlayerWithLastActivity[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_players_with_last_activity`, {
    method: 'POST',
    headers: headers(),
    body: '{}',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`get_players_with_last_activity failed (${res.status}): ${body}`);
  }
  return await res.json();
}

/**
 * RPC: get_player_activity_timeline(p_player_id, p_limit)
 *
 * Reverse-chronological event timeline for one player. Group and season
 * names are joined in by the function; for `group_switch` events,
 * `from_group_name` is resolved from `metadata.from_group_id`.
 */
export interface ActivityTimelineRow {
  id: string;
  occurred_at: string;
  event_type: string;
  source_table: 'login_events' | 'user_events';
  group_id: string | null;
  group_name: string | null;
  season_id: string | null;
  season_start_date: string | null;
  season_end_date: string | null;
  metadata: Record<string, unknown> | null;
  from_group_id: string | null;
  from_group_name: string | null;
}

export async function getPlayerActivityTimeline(
  playerId: string,
  limit = 100,
): Promise<ActivityTimelineRow[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_player_activity_timeline`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ p_player_id: playerId, p_limit: limit }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`get_player_activity_timeline failed (${res.status}): ${body}`);
  }
  return await res.json();
}

/**
 * RPC: get_player_activity_summary(p_player_id)
 *
 * Aggregate counts for the detail page summary block.
 */
export interface PlayerActivitySummary {
  total_events: number;
  first_event_at: string | null;
  last_event_at: string | null;
  event_type_counts: Record<string, number>;
}

export async function getPlayerActivitySummary(playerId: string): Promise<PlayerActivitySummary> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_player_activity_summary`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ p_player_id: playerId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`get_player_activity_summary failed (${res.status}): ${body}`);
  }
  // The function returns a single-row TABLE — PostgREST gives us an array
  // of one element. Normalize to the object.
  const rows = await res.json();
  if (Array.isArray(rows) && rows.length > 0) return rows[0];
  return { total_events: 0, first_event_at: null, last_event_at: null, event_type_counts: {} };
}

// =============================================================================
// Display helpers — shared between list and detail views
// =============================================================================

/**
 * Map raw event_type strings to user-facing labels. Unknown event types
 * pass through unchanged so a future event_type appears with its slug
 * rather than disappearing from the UI.
 */
export function eventTypeLabel(eventType: string | null | undefined): string {
  if (!eventType) return '—';
  switch (eventType) {
    case 'login_success':    return 'Logged in';
    case 'logout':           return 'Logged out';
    case 'group_switch':     return 'Switched groups';
    case 'view_leaderboard': return 'Viewed Standings';
    case 'view_rounds_list': return 'Viewed Rounds';
    default:                 return eventType;
  }
}

/**
 * Format a season's date range as a display label. Mirrors `seasonLabel`
 * in windex-admin/src/types — the year at the midpoint of start..end.
 * Used for the "season" column in the timeline.
 */
export function seasonYearLabel(startDate: string | null, endDate: string | null): string | null {
  if (!startDate) return null;
  const start = new Date(startDate + 'T00:00:00');
  const end = endDate ? new Date(endDate + 'T00:00:00') : start;
  const mid = new Date((start.getTime() + end.getTime()) / 2);
  return String(mid.getFullYear());
}

/** Pretty-print an ISO timestamp as "May 11, 2026 3:35 PM" in local time. */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return 'NA';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Compact relative-time. Returns null for null inputs. */
export function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}
