import { apiFetch, ApiError, getAuthToken } from './client';
import type { Group, Season } from '../types';

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

/**
 * List groups. GET /groups. If missing (404), returns [] so UI remains navigable.
 */
export async function listGroups(): Promise<Group[]> {
  try {
    const data = await apiFetch<{ groups?: Group[]; data?: Group[] }>('/groups');
    return (data as { groups?: Group[] })?.groups ?? (data as { data?: Group[] })?.data ?? [];
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return [];
    throw e;
  }
}

/**
 * List seasons. GET /seasons?group_id=. If missing (404), returns [].
 */
export async function listSeasons(groupId?: string): Promise<Season[]> {
  const path = groupId ? `/seasons?group_id=${encodeURIComponent(groupId)}` : '/seasons';
  try {
    const data = await apiFetch<{ seasons?: Season[]; data?: Season[] }>(path);
    return (data as { seasons?: Season[] })?.seasons ?? (data as { data?: Season[] })?.data ?? [];
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return [];
    throw e;
  }
}

/**
 * Calls the am_i_super_admin() SQL helper (defined in migration 014_permissions.sql)
 * via PostgREST RPC. Returns false on any failure so the UI defaults to hiding
 * super-admin-only affordances.
 */
export async function isCurrentUserSuperAdmin(): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/am_i_super_admin`, {
      method: 'POST',
      headers: restHeaders(),
      body: '{}',
    });
    if (!res.ok) return false;
    const text = await res.text();
    if (!text) return false;
    const parsed = JSON.parse(text);
    return parsed === true;
  } catch {
    return false;
  }
}

export interface GroupDeleteCounts {
  members: number;
  seasons: number;
  rounds: number;
  scores: number;
}

function parseCountHeader(value: string | null): number {
  // PostgREST Content-Range looks like "0-0/123" or "*/0".
  if (!value) return 0;
  const slash = value.lastIndexOf('/');
  if (slash < 0) return 0;
  const tail = value.slice(slash + 1);
  if (tail === '*') return 0;
  const n = Number(tail);
  return Number.isFinite(n) ? n : 0;
}

async function countRows(path: string): Promise<number> {
  // Append limit=1 so we don't pull every row, but Prefer: count=exact still
  // populates Content-Range with the full count. Plain `Range: 0-0` returns
  // 416 against empty result sets in PostgREST, so we avoid it here.
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}${sep}limit=1`, {
    method: 'GET',
    headers: restHeaders({ Prefer: 'count=exact' }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Count query failed (${res.status}): ${body || path}`);
  }
  return parseCountHeader(res.headers.get('Content-Range'));
}

/**
 * Returns the row counts that would be removed by a cascade delete of the
 * given group. Display-only — the actual delete is a single DELETE on `groups`.
 *
 * `scores` is computed via league_rounds.id IN (...) since league_scores has
 * no direct FK to groups; cleanup is transitive through league_rounds.
 */
export async function getGroupDeleteCounts(groupId: string): Promise<GroupDeleteCounts> {
  const gid = encodeURIComponent(groupId);

  // Collect round IDs first so we can scope the league_scores count.
  const roundsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/league_rounds?group_id=eq.${gid}&select=id`,
    { headers: restHeaders() }
  );
  if (!roundsRes.ok) {
    const body = await roundsRes.text().catch(() => '');
    throw new Error(`Failed to load rounds (${roundsRes.status}): ${body}`);
  }
  const roundRows: { id: string }[] = await roundsRes.json();
  const roundIds = roundRows.map((r) => r.id);

  const [members, seasons, rounds] = await Promise.all([
    countRows(`group_members?group_id=eq.${gid}&select=id`),
    countRows(`seasons?group_id=eq.${gid}&select=id`),
    Promise.resolve(roundIds.length),
  ]);

  let scores = 0;
  if (roundIds.length > 0) {
    const inList = roundIds.map((id) => `"${id}"`).join(',');
    scores = await countRows(`league_scores?league_round_id=in.(${inList})&select=id`);
  }

  return { members, seasons, rounds, scores };
}

/**
 * Hard delete of a group. Relies on FK ON DELETE CASCADE for group_members,
 * seasons, league_rounds (and transitively league_scores via league_rounds).
 * Players are intentionally not cleaned up — orphans are left in place.
 *
 * RLS (groups_delete in migration 015_rls_overhaul.sql) requires the caller
 * to be a super admin.
 */
export async function deleteGroup(groupId: string): Promise<void> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/groups?id=eq.${encodeURIComponent(groupId)}`,
    {
      method: 'DELETE',
      headers: restHeaders({ Prefer: 'return=minimal' }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let parsed: { message?: string; details?: string } | null = null;
    try { parsed = body ? JSON.parse(body) : null; } catch { /* keep raw */ }
    const msg = parsed?.message ?? parsed?.details ?? body ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
}
