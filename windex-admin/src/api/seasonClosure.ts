import { getAuthToken, writeHeaders } from './client';

const SUPABASE_URL = (
  typeof import.meta.env !== 'undefined' && import.meta.env.VITE_LATE_ADD_API_URL
    ? import.meta.env.VITE_LATE_ADD_API_URL
    : 'https://ftmqzxykwcccocogkjhc.supabase.co/functions/v1'
).replace(/\/functions\/v1\/?$/, '');

const ANON_KEY =
  typeof import.meta.env !== 'undefined' && import.meta.env.VITE_SUPABASE_ANON_KEY
    ? import.meta.env.VITE_SUPABASE_ANON_KEY
    : null;

function readHeaders(): Record<string, string> {
  const token = getAuthToken() ?? ANON_KEY;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(ANON_KEY ? { apikey: ANON_KEY } : {}),
  };
}

/**
 * seasons.closed_at per season for a group (migration 058). Read straight from
 * PostgREST because the /seasons Edge Function's select list predates the
 * column — the edge function stays untouched until the Phase 2 cleanup. Returns
 * an empty map on failure so the page still renders (every season reads as open).
 */
export async function listSeasonClosures(groupId: string): Promise<Map<string, string | null>> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/seasons?group_id=eq.${encodeURIComponent(groupId)}&select=id,closed_at`,
      { headers: readHeaders() },
    );
    if (!res.ok) return new Map();
    const rows: { id: string; closed_at: string | null }[] = await res.json();
    return new Map(rows.map((r) => [r.id, r.closed_at]));
  } catch {
    return new Map();
  }
}

export type CloseSeasonResult = { season_id: string; closed_at: string; snapshot_rows: number };
export type ReopenSeasonResult = { season_id: string; reopened_at: string; snapshot_rows_deleted: number };

/**
 * POST a closure RPC (migration 060). Both are super-admin gated and atomic in
 * the database: on any guard failure nothing changes and PostgREST returns the
 * RAISE text as `message`, which is shown to the admin verbatim.
 */
async function closureRpc<T>(fn: 'close_season' | 'reopen_season', seasonId: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify({ p_season_id: seasonId }),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text || `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed?.message) msg = parsed.message;
    } catch {
      /* keep raw text */
    }
    throw new Error(msg);
  }
  return JSON.parse(text) as T;
}

/** Freeze the season's standings into season_standings_final and set closed_at. */
export function closeSeason(seasonId: string): Promise<CloseSeasonResult> {
  return closureRpc<CloseSeasonResult>('close_season', seasonId);
}

/** Delete the season's snapshot rows and clear closed_at. */
export function reopenSeason(seasonId: string): Promise<ReopenSeasonResult> {
  return closureRpc<ReopenSeasonResult>('reopen_season', seasonId);
}
