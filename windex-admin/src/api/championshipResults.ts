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
 * Replace the entire finishing order for a season:
 *   1. DELETE every championship_results row for the season.
 *   2. INSERT the new rows.
 *
 * Why full-replace instead of diff: the table is small (one Windex group =
 * ~10-20 finishers) and the admin UX is "edit the whole list, click save".
 * Doing a diff would add code without saving meaningful round-trips, and
 * makes ordering changes (which shift many rows' `place` values) noisier.
 *
 * Both operations are sequential and NOT transactional from the client side
 * — there's a brief window between DELETE and INSERT where the season has
 * no results. RLS makes this admin-only, and the sync trigger will null out
 * seasons.cup_champion_player_id transiently then re-set it on insert.
 * Acceptable for now; if it ever matters, lift to an Edge Function.
 *
 * Validation note: the membership-enforcement trigger fires per row on
 * INSERT for current-season entries. If any row fails (non-member), the
 * INSERT errors mid-batch leaving partial state. Surface the error so the
 * admin can fix and retry.
 */
export async function replaceFinishingOrder(
  seasonId: string,
  groupId: string,
  entries: FinishingOrderEntry[],
): Promise<void> {
  // 1. Delete all existing rows for this season.
  const delRes = await fetch(
    `${SUPABASE_URL}/rest/v1/championship_results?season_id=eq.${encodeURIComponent(seasonId)}`,
    {
      method: 'DELETE',
      headers: restHeaders({ Prefer: 'return=minimal' }),
    }
  );
  if (!delRes.ok) {
    const body = await delRes.text().catch(() => '');
    let parsed: { message?: string; details?: string } | null = null;
    try { parsed = body ? JSON.parse(body) : null; } catch { /* keep raw */ }
    const msg = parsed?.message ?? parsed?.details ?? body ?? `HTTP ${delRes.status}`;
    throw new Error(`Failed to clear existing results: ${msg}`);
  }

  if (entries.length === 0) return;

  // 2. Insert the new rows. PostgREST accepts an array body for bulk insert.
  const payload = entries.map((e) => ({
    season_id: seasonId,
    group_id: groupId,
    player_id: e.player_id,
    place: e.place,
    is_last_place: e.is_last_place,
  }));
  const insRes = await fetch(
    `${SUPABASE_URL}/rest/v1/championship_results`,
    {
      method: 'POST',
      headers: restHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify(payload),
    }
  );
  if (!insRes.ok) {
    const body = await insRes.text().catch(() => '');
    let parsed: { message?: string; details?: string } | null = null;
    try { parsed = body ? JSON.parse(body) : null; } catch { /* keep raw */ }
    const msg = parsed?.message ?? parsed?.details ?? body ?? `HTTP ${insRes.status}`;
    throw new Error(`Failed to insert results: ${msg}`);
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
