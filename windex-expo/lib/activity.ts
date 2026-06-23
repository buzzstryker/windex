/**
 * App Activity data layer — ports windex-admin/src/api/activity.ts to the
 * expo raw-fetch-to-PostgREST pattern.
 *
 * All three RPCs are defined in deployed migration 024_activity_events_view.sql
 * and granted to `authenticated`. They are SECURITY INVOKER over the
 * `activity_events` view (also security_invoker), whose underlying tables gate
 * SELECT to `am_i_super_admin()`. So a super-admin session receives data and a
 * non-super-admin gets empty/null rows. The screens additionally self-gate on
 * `useGroup().isSuperAdmin`.
 */
import { getStoredAccessToken } from './api';
import { getApiBase, getSupabaseAnonKey } from './config';

/** PostgREST base (strip the Edge Functions suffix from the shared API base). */
function restBase(): string {
  return getApiBase().replace(/\/functions\/v1\/?$/, '');
}

async function rpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const base = restBase();
  const token = await getStoredAccessToken();
  const anonKey = getSupabaseAnonKey();
  if (!base || !token) throw new Error('Sign in first');
  const res = await fetch(`${base}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: anonKey || token,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${name} failed (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
}

// =============================================================================
// RPC fetchers
// =============================================================================

/**
 * RPC: get_players_with_last_activity()
 * One row per player, LEFT JOINed to their most-recent activity_events entry.
 * Sorted last_event_at DESC NULLS LAST, then display_name ASC.
 */
export interface PlayerWithLastActivity {
  player_id: string;
  display_name: string;
  email: string | null;
  last_event_at: string | null;
  last_event_type: string | null;
}

export function getPlayersWithLastActivity(): Promise<PlayerWithLastActivity[]> {
  return rpc<PlayerWithLastActivity[]>('get_players_with_last_activity', {});
}

/**
 * RPC: get_player_activity_timeline(p_player_id, p_limit)
 * Reverse-chronological event timeline for one player, with group + season
 * names resolved and the group_switch from-group resolved from metadata.
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

export function getPlayerActivityTimeline(
  id: string,
  limit = 100,
): Promise<ActivityTimelineRow[]> {
  return rpc<ActivityTimelineRow[]>('get_player_activity_timeline', {
    p_player_id: id,
    p_limit: limit,
  });
}

/**
 * RPC: get_player_activity_summary(p_player_id)
 * Aggregate counts for the detail page summary block. The function returns a
 * single-row TABLE — PostgREST gives an array of one element; normalize to the
 * object.
 */
export interface PlayerActivitySummary {
  total_events: number;
  first_event_at: string | null;
  last_event_at: string | null;
  event_type_counts: Record<string, number>;
}

export async function getPlayerActivitySummary(id: string): Promise<PlayerActivitySummary> {
  const rows = await rpc<PlayerActivitySummary[]>('get_player_activity_summary', {
    p_player_id: id,
  });
  if (Array.isArray(rows) && rows.length > 0) return rows[0];
  return { total_events: 0, first_event_at: null, last_event_at: null, event_type_counts: {} };
}

// =============================================================================
// Display helpers — shared between list and detail views
// =============================================================================

/**
 * Map raw event_type slugs to user-facing labels. Unknown types pass through
 * unchanged so a future event_type appears with its slug rather than
 * disappearing. NB: the underlying event_type keys are unchanged
 * (`view_rounds_list` stays the key); only the human label reads "Matches"
 * per the Rounds→Matches copy rule.
 */
export function eventTypeLabel(eventType: string | null | undefined): string {
  if (!eventType) return '—';
  switch (eventType) {
    case 'login_success':    return 'Logged in';
    case 'logout':           return 'Logged out';
    case 'group_switch':     return 'Switched groups';
    case 'view_leaderboard': return 'Viewed Standings';
    case 'view_rounds_list': return 'Viewed Matches';
    default:                 return eventType;
  }
}

/**
 * Format a season's date range as a display label — the year at the midpoint
 * of start..end. Used for the season context in the timeline.
 */
export function seasonYearLabel(startDate: string | null, endDate: string | null): string | null {
  if (!startDate) return null;
  const start = new Date(startDate + 'T00:00:00');
  const end = endDate ? new Date(endDate + 'T00:00:00') : start;
  const mid = new Date((start.getTime() + end.getTime()) / 2);
  return String(mid.getFullYear());
}

/** Pretty-print an ISO timestamp as "May 11, 2026, 3:35 PM" in local time. */
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
