/**
 * Fire-and-forget user-activity logger. Writes rows to public.user_events
 * (migration 023) directly via PostgREST under RLS. The RLS policy
 * `user_events_insert_own` requires `user_id = auth.uid()`, so we extract
 * the user id from the JWT's `sub` claim and include it in the body.
 *
 * Design rules:
 *   - NEVER throws. Errors are warned to console and swallowed. UI must
 *     not break if logging breaks.
 *   - NEVER awaited by callers (the function is async because the network
 *     write is async, but call sites use `void logUserEvent(...)`).
 *   - No retries, no queueing. Best-effort. Drops on the floor if the user
 *     is offline or the API is unreachable.
 *   - player_id is passed in from the caller (typically `myPlayerIds[0]`
 *     from GroupContext). If unknown, it stays null on the row — the
 *     denormalized column is recoverable via JOIN at query time.
 *
 * Event pairing note (by design, not a bug):
 *   A user switching groups produces TWO rows in user_events, in this order:
 *     1. group_switch  — fired from GroupContext.selectGroup
 *     2. view_leaderboard  — fired from the standings.tsx effect whose deps
 *                            (selectedGroup.id, selectedSeason.id) just
 *                            changed as a result of the switch
 *   This is correct event-stream semantics: the user did switch, and they
 *   are now viewing the new group's leaderboard. But a naive "views per
 *   group" query that doesn't filter by event_type will overcount by ~1x
 *   per switch. Future viewers / analytics queries should either filter
 *   `event_type = 'view_leaderboard'` explicitly or de-dup within a short
 *   window when a group_switch immediately precedes a view_*. Same pattern
 *   applies to view_rounds_list when switching groups while on the Rounds
 *   tab.
 */
import { getStoredAccessToken } from '@/lib/api';
import { getApiBase, getSupabaseAnonKey } from '@/lib/config';

export type UserEventType =
  | 'group_switch'
  | 'view_leaderboard'
  | 'view_rounds_list';

export interface LogUserEventParams {
  groupId?: string | null;
  seasonId?: string | null;
  /** Pass from GroupContext.myPlayerIds[0]. Stays null on the row if omitted. */
  playerId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Decode the `sub` claim from a Supabase JWT. Returns null on any failure. */
function userIdFromJwt(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    // The JWT payload is base64url. atob handles standard base64; we
    // normalize first.
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    const payload = JSON.parse(json) as { sub?: string };
    return payload?.sub ?? null;
  } catch {
    return null;
  }
}

export async function logUserEvent(
  eventType: UserEventType,
  params: LogUserEventParams = {},
): Promise<void> {
  try {
    const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
    const token = await getStoredAccessToken();
    if (!base || !token) return; // not signed in / not configured — silent no-op

    const userId = userIdFromJwt(token);
    if (!userId) return; // malformed token — silent no-op (RLS would reject anyway)

    const anonKey = getSupabaseAnonKey();
    const body = {
      user_id: userId,
      player_id: params.playerId ?? null,
      event_type: eventType,
      group_id: params.groupId ?? null,
      season_id: params.seasonId ?? null,
      metadata: params.metadata ?? {},
    };

    const res = await fetch(`${base}/rest/v1/user_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: anonKey || token,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`logUserEvent(${eventType}) failed:`, res.status, text);
    }
  } catch (err) {
    console.warn(`logUserEvent(${eventType}) threw:`, err);
  }
}
