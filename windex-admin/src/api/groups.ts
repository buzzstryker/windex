import { apiFetch, ApiError, getAuthToken, writeHeaders } from './client';
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
 * Read groups.season_start_month directly via PostgREST. The /groups Edge
 * Function doesn't return this column, but the Create Season form needs it
 * to default the start_date intelligently. Returns null if the group is
 * missing or the column is null/0 ("no schedule").
 */
export async function getGroupSeasonStartMonth(groupId: string): Promise<number | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/groups?id=eq.${encodeURIComponent(groupId)}&select=season_start_month`,
    { headers: restHeaders() }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to read season_start_month (${res.status}): ${body}`);
  }
  const rows: { season_start_month: number | null }[] = await res.json();
  if (rows.length === 0) return null;
  const v = rows[0].season_start_month;
  if (v === null || v === 0) return null;
  return v;
}

/**
 * Insert a season row directly via PostgREST. RLS policy `seasons_insert`
 * (migration 015) requires the caller to be a super admin or a group admin
 * for the target group. Returns the inserted row.
 *
 * id pattern matches `ensure_next_season_for_group` in migration 021:
 * `sn_<sanitized_group_id>_<endYear>`. Sanitization mirrors the SQL
 * `regexp_replace([^a-zA-Z0-9_-], '_')`.
 */
export interface CreateSeasonInput {
  group_id: string;
  start_date: string; // 'YYYY-MM-DD'
  end_date: string;   // 'YYYY-MM-DD'
}

export interface CreateSeasonResult {
  id: string;
  group_id: string;
  start_date: string;
  end_date: string;
}

export async function createSeason(input: CreateSeasonInput): Promise<CreateSeasonResult> {
  const safeGroupId = input.group_id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const endYear = input.end_date.slice(0, 4);
  const id = `sn_${safeGroupId}_${endYear}`;
  const body = {
    id,
    group_id: input.group_id,
    start_date: input.start_date,
    end_date: input.end_date,
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/seasons`, {
    method: 'POST',
    headers: restHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: { message?: string; details?: string } | null = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
    const msg = parsed?.message ?? parsed?.details ?? text ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const rows: CreateSeasonResult[] = await res.json();
  return rows[0];
}

/**
 * Calls the `create-group` Edge Function. Sends multipart/form-data with a
 * JSON `payload` part and an optional `image` part. The Edge Function does
 * its own super-admin gate, name uniqueness check, image upload, and atomic
 * groups + group_members insert (with rollback on failure).
 *
 * 409 (duplicate name) is surfaced as a typed DuplicateGroupNameError so the
 * UI can offer "view existing group" without parsing strings.
 */
export interface CreateGroupInput {
  name: string;
  season_start_month: number; // 1..12
  admin_player_ids: string[];
  image: File | null;
}

export interface CreateGroupResult {
  id: string;
  name: string;
  logo_url: string | null;
  season_start_month: number;
  section_id: string | null;
  dollars_per_point: number | null;
  user_id: string;
  created_at: string;
}

export class DuplicateGroupNameError extends Error {
  constructor(public existingGroupId: string) {
    super('A group with this name already exists');
    this.name = 'DuplicateGroupNameError';
  }
}

export async function createGroup(input: CreateGroupInput): Promise<CreateGroupResult> {
  const form = new FormData();
  form.append(
    'payload',
    JSON.stringify({
      name: input.name,
      season_start_month: input.season_start_month,
      admin_player_ids: input.admin_player_ids,
    })
  );
  if (input.image) form.append('image', input.image, input.image.name);

  const token = getAuthToken() ?? ANON_KEY;
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (ANON_KEY) headers['apikey'] = ANON_KEY;
  // Do NOT set Content-Type — the browser sets it with the multipart boundary.

  const res = await fetch(`${SUPABASE_URL}/functions/v1/create-group`, {
    method: 'POST',
    headers,
    body: form,
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep raw */ }

  if (!res.ok) {
    if (res.status === 409) {
      const b = body as { existing_group_id?: string } | null;
      if (b?.existing_group_id) throw new DuplicateGroupNameError(b.existing_group_id);
    }
    const b = body as { error?: string; details?: string } | null;
    throw new Error(b?.error ?? b?.details ?? `HTTP ${res.status}`);
  }
  const ok = body as { group?: CreateGroupResult } | null;
  if (!ok?.group) throw new Error('Malformed response from create-group');
  return ok.group;
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
      // return=representation + live-session write headers: a DELETE that
      // matches 0 rows (RLS-filtered / already gone) otherwise returns 204 and
      // looks like success. Surface it instead.
      headers: writeHeaders({ Prefer: 'return=representation' }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let parsed: { message?: string; details?: string } | null = null;
    try { parsed = body ? JSON.parse(body) : null; } catch { /* keep raw */ }
    const msg = parsed?.message ?? parsed?.details ?? body ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const rows = await res.json().catch(() => null);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Nothing was deleted — the group was not found or you do not have permission to delete it.');
  }
}
