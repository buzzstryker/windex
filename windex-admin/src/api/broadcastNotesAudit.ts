import { apiFetch, getAuthToken } from './client';

/**
 * Broadcast Notes audit API.
 *
 * - List: GET /list-broadcast-notes-audits edge function (super-admin gated,
 *   returns the last 10 rows with computed claim stats + group name).
 * - Detail: direct PostgREST read of broadcast_notes_log (RLS policy
 *   broadcast_notes_log_super_admin_read, migration 031, allows super admins).
 *   Mirrors the `?id=eq.` single-row read pattern used in groups.ts/events.ts.
 * - Regenerate: POST /generate-broadcast-notes (the same edge function the PWA
 *   calls) with { group_id, player_ids } — so the audit row is written the
 *   same way. The generate response does NOT include the new row id, so the
 *   caller re-fetches the list and navigates to the newest (top) row.
 */

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

export type FactCheckStatus = 'none' | 'error' | 'ok';

export interface BroadcastNotesAuditRow {
  id: string;
  created_at: string;
  group_name: string | null;
  spotlight_names: string[];
  total_claims: number;
  wrong_count: number;
  ambiguous_count: number;
  fact_check_status: FactCheckStatus;
}

export type AnnotationStatus = 'verified' | 'wrong' | 'ambiguous' | 'unverifiable';

/**
 * One Perplexity annotation. NOTE: the persisted audit stores only the
 * fact-checker's verdict — the original claim TEXT and SOURCE are not
 * persisted anywhere (they were sent to Perplexity but not stored). The UI
 * surfaces id/status/correction/reasoning and notes the gap.
 */
export interface FactCheckAnnotation {
  id: string;
  status: AnnotationStatus | string;
  correction?: string;
  reasoning?: string;
}

/**
 * The original stage-1 claim. Persisted in fact_check_audit only for
 * generations created after the claims-persistence change. When absent (older
 * rows), the UI falls back to showing the annotation id with a gap banner.
 */
export interface FactCheckClaim {
  id: string;
  claim: string;
  source: string;
}

export interface FactCheckAudit {
  claims?: FactCheckClaim[];
  annotations?: FactCheckAnnotation[];
  perplexity_model?: string;
  claude_model?: string;
  generated_at?: string;
  error?: string;
}

export interface BroadcastNotesAuditDetail {
  id: string;
  created_at: string;
  group_id: string;
  group_name: string | null;
  spotlight_names: string[];
  player_ids: string[];
  model: string | null;
  output_length: number | null;
  generation_ms: number | null;
  fact_check_audit: FactCheckAudit | null;
  input_data: unknown | null;
}

/** Last 10 generations (super-admin only; non-super-admins get a 403). */
export async function listBroadcastNotesAudits(): Promise<BroadcastNotesAuditRow[]> {
  const data = await apiFetch<{ rows?: BroadcastNotesAuditRow[] }>('/list-broadcast-notes-audits');
  return data?.rows ?? [];
}

/** Full audit row by id, via PostgREST (super-admin RLS gates the read). */
export async function getBroadcastNotesAudit(id: string): Promise<BroadcastNotesAuditDetail | null> {
  const select =
    'id,created_at,group_id,spotlight_names,player_ids,model,output_length,generation_ms,fact_check_audit,input_data,groups(name)';
  const url = `${SUPABASE_URL}/rest/v1/broadcast_notes_log?id=eq.${encodeURIComponent(id)}&select=${encodeURIComponent(select)}`;
  const res = await fetch(url, { headers: restHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to load audit row (${res.status}): ${body}`);
  }
  const rows = (await res.json()) as Array<
    Omit<BroadcastNotesAuditDetail, 'group_name'> & { groups: { name: string } | { name: string }[] | null }
  >;
  if (rows.length === 0) return null;
  const r = rows[0];
  const grp = Array.isArray(r.groups) ? r.groups[0] : r.groups;
  return {
    id: r.id,
    created_at: r.created_at,
    group_id: r.group_id,
    group_name: grp?.name ?? null,
    spotlight_names: r.spotlight_names ?? [],
    player_ids: r.player_ids ?? [],
    model: r.model ?? null,
    output_length: r.output_length ?? null,
    generation_ms: r.generation_ms ?? null,
    fact_check_audit: r.fact_check_audit ?? null,
    input_data: r.input_data ?? null,
  };
}

export interface RegenerateResult {
  notes: string;
  generated_at?: string;
  spotlight_names?: string[];
  fact_check?: unknown;
}

/**
 * Re-run a generation through the same edge function the PWA uses. Hard-fails
 * with a specific error on any pipeline failure (the function surfaces it).
 */
export async function regenerateBroadcastNotes(
  groupId: string,
  playerIds: string[]
): Promise<RegenerateResult> {
  return apiFetch<RegenerateResult>('/generate-broadcast-notes', {
    method: 'POST',
    body: JSON.stringify({ group_id: groupId, player_ids: playerIds }),
  });
}
