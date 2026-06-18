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

function restHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getAuthToken() ?? ANON_KEY;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(ANON_KEY ? { apikey: ANON_KEY } : {}),
    ...(extra ?? {}),
  };
}

export interface ChampionshipResult {
  id: string;
  season_id: string;
  group_id: string;
  player_id: string;
  /** NULL only for award-only rows (historical socks, field size unknown). */
  place: number | null;
  /** FJ Socks: explicit last-place award (migration 046). */
  is_last_place: boolean;
}

/**
 * List championship_results for a single season, ordered by place ascending
 * then created_at ascending so ties land in a stable order.
 */
export async function listChampionshipResults(seasonId: string): Promise<ChampionshipResult[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/championship_results` +
    `?season_id=eq.${encodeURIComponent(seasonId)}` +
    `&select=id,season_id,group_id,player_id,place,is_last_place` +
    `&order=place.asc,created_at.asc`,
    { headers: restHeaders() }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to load championship results (${res.status}): ${body}`);
  }
  return res.json();
}

/**
 * Batch-load championship_results across many seasons in one round trip.
 * Used by the list view to populate top-3 inline without N+1 fetches.
 */
export async function listChampionshipResultsForSeasons(
  seasonIds: string[]
): Promise<ChampionshipResult[]> {
  if (seasonIds.length === 0) return [];
  const inList = seasonIds.map((id) => `"${id}"`).join(',');
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/championship_results` +
    `?season_id=in.(${inList})` +
    `&select=id,season_id,group_id,player_id,place,is_last_place` +
    `&order=season_id.asc,place.asc,created_at.asc`,
    { headers: restHeaders() }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to load championship results (${res.status}): ${body}`);
  }
  return res.json();
}

export interface FinishingOrderEntry {
  player_id: string;
  /** NULL allowed only when is_last_place (CHECK championship_results_place_or_award). */
  place: number | null;
  is_last_place: boolean;
}

/**
 * Thrown when a request is rejected because the admin's JWT has expired
 * (PostgREST 401 / code PGRST301). Distinct from a generic save failure so
 * the UI can show a re-authenticate affordance instead of the raw PostgREST
 * "JWT expired" string. See replaceFinishingOrder and the BACKLOG item on
 * the admin's access-token-only session (no refresh today).
 */
export class AuthExpiredError extends Error {
  constructor(message = 'Your session expired') {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

/**
 * Replace the entire finishing order for a season in ONE atomic transaction
 * via the replace_finishing_order RPC (migration 047). The RPC does the
 * DELETE + INSERT inside a single SECURITY DEFINER function body, so a failed
 * INSERT (membership/group trigger rejection) rolls the DELETE back with it —
 * the season can never be left wiped-with-nothing-inserted. Super-admin is
 * enforced server-side by the function's am_i_super_admin() gate.
 *
 * Why full-replace instead of diff: the table is small (one Windex group =
 * ~10-20 finishers) and the admin UX is "edit the whole list, click save".
 *
 * Row shape sent to the RPC carries only { player_id, place, is_last_place };
 * season_id/group_id are passed as params and applied server-side. An empty
 * list clears the season atomically (delete-only). Throws AuthExpiredError on
 * an expired-JWT rejection so the caller can offer re-auth.
 */
export async function replaceFinishingOrder(
  seasonId: string,
  groupId: string,
  entries: FinishingOrderEntry[],
): Promise<void> {
  const rows = entries.map((e) => ({
    player_id: e.player_id,
    place: e.place,
    is_last_place: e.is_last_place,
  }));
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/replace_finishing_order`, {
    method: 'POST',
    headers: restHeaders(),
    body: JSON.stringify({ p_season_id: seasonId, p_group_id: groupId, p_rows: rows }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let parsed: { message?: string; details?: string; code?: string } | null = null;
    try { parsed = body ? JSON.parse(body) : null; } catch { /* keep raw */ }
    // Expired JWT: PostgREST returns 401 with code PGRST301. Surface a typed
    // error so the UI maps it to friendly copy + a recovery affordance rather
    // than echoing the raw "JWT expired" string.
    if (res.status === 401 || parsed?.code === 'PGRST301') {
      throw new AuthExpiredError();
    }
    const msg = parsed?.message ?? parsed?.details ?? body ?? `HTTP ${res.status}`;
    throw new Error(`Failed to save results: ${msg}`);
  }
}

/**
 * Validate that a list of finishing places follows standard competition
 * ranking — e.g. (1, 2, 2, 4, 5) is valid; (1, 2, 3, 3, 4) is not (next
 * after the tie at 3 should be 5).
 *
 * Returns null when valid; otherwise a human-readable message describing
 * the first violation. Used as a non-blocking warning in the UI per locked
 * spec — admins can override and save anyway.
 */
export function validateStandardCompetitionRanking(places: number[]): string | null {
  if (places.length === 0) return null;
  const sorted = [...places].sort((a, b) => a - b);

  // First place must start at 1.
  if (sorted[0] !== 1) {
    return `First place should be 1, got ${sorted[0]}.`;
  }

  // Group runs of identical places; the next-place value must be
  // (current_place + count_at_current_place).
  let i = 0;
  while (i < sorted.length) {
    const cur = sorted[i];
    let count = 1;
    while (i + count < sorted.length && sorted[i + count] === cur) count += 1;
    const nextIdx = i + count;
    if (nextIdx < sorted.length) {
      const expectedNext = cur + count;
      if (sorted[nextIdx] !== expectedNext) {
        const tieDesc = count > 1 ? ` (${count}-way tie at ${cur})` : '';
        return `After place ${cur}${tieDesc} the next place should be ${expectedNext}, got ${sorted[nextIdx]}.`;
      }
    }
    i = nextIdx;
  }
  return null;
}
