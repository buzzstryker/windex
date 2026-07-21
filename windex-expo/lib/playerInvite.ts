// PWA super-admin add/invite-player wrappers. Reuses the same Edge Functions
// and RPC as windex-admin: invite-player (create), send-invite (the ONLY send
// path — two-email model), get_players_auth_status (server-side auth status).
import { getApiBase, getSupabaseAnonKey } from './config';
import { apiFetch, getStoredAccessToken } from './api';

export type PlayerLite = {
  id: string;
  display_name: string;
  full_name: string | null;
  email: string | null;
  user_id: string | null;
  /** Non-null = retired/resigned (migration 029). Retired players are filtered
   *  out of standings (migration 030); the sheet marks them but doesn't block. */
  retired_at: string | null;
};

export type PlayerAuthStatus = {
  player_id: string;
  has_signed_in: boolean;
  invited_at: string | null;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
};

export type InviteStatus = 'not_invited' | 'invited' | 'signed_in';

/** never invited (no auth user) / invited-pending / signed-in. */
export function deriveInviteStatus(
  userId: string | null,
  status: PlayerAuthStatus | undefined,
): InviteStatus {
  if (!userId) return 'not_invited';
  return status?.has_signed_in ? 'signed_in' : 'invited';
}

// TWIN: keep identical to windex-admin/src/pages/Players.tsx buildSignInInstructions.
// If you edit one, edit the other (the two apps don't share code).
export function buildSignInInstructions(email: string): string {
  return `Go to windexgolf.com/login, enter your email (${email}), tap "Send Login Code", then check your email and enter the 6-digit code to sign in.`;
}

function restCtx() {
  const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
  const anonKey = getSupabaseAnonKey();
  return { base, anonKey };
}

/** Search players by name or email (PostgREST; players_select is USING(true)). */
export async function searchPlayers(q: string): Promise<PlayerLite[]> {
  const query = q.trim();
  if (!query) return [];
  const { base, anonKey } = restCtx();
  const token = await getStoredAccessToken();
  if (!base || !token) return [];
  const headers = { Authorization: `Bearer ${token}`, apikey: anonKey || token };
  const enc = encodeURIComponent(query);
  const or = `or=(display_name.ilike.*${enc}*,full_name.ilike.*${enc}*,email.ilike.*${enc}*)`;
  const res = await fetch(
    `${base}/rest/v1/players?${or}&select=id,display_name,full_name,email,user_id,retired_at&order=display_name.asc&limit=25`,
    { headers },
  );
  if (!res.ok) return [];
  return res.json();
}

/** Exact-email lookup — used to catch a duplicate BEFORE any write. */
export async function findPlayerByEmail(email: string): Promise<PlayerLite | null> {
  const e = email.trim().toLowerCase();
  if (!e) return null;
  const { base, anonKey } = restCtx();
  const token = await getStoredAccessToken();
  if (!base || !token) return null;
  const headers = { Authorization: `Bearer ${token}`, apikey: anonKey || token };
  const res = await fetch(
    `${base}/rest/v1/players?email=eq.${encodeURIComponent(e)}&select=id,display_name,full_name,email,user_id,retired_at&limit=1`,
    { headers },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as PlayerLite[];
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * Per-player auth status via the get_players_auth_status RPC (migration 027).
 * The RPC self-gates on am_i_super_admin() and returns an EMPTY set for a
 * non-super caller, so this degrades gracefully (empty Map, never throws).
 */
export async function getPlayersAuthStatus(): Promise<Map<string, PlayerAuthStatus>> {
  const { base, anonKey } = restCtx();
  const token = await getStoredAccessToken();
  if (!base || !token) return new Map();
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: anonKey || token };
  try {
    const res = await fetch(`${base}/rest/v1/rpc/get_players_auth_status`, { method: 'POST', headers, body: '{}' });
    if (!res.ok) return new Map();
    const rows = (await res.json()) as PlayerAuthStatus[];
    return new Map(rows.map((r) => [r.player_id, r]));
  } catch {
    return new Map();
  }
}

// ── Group membership writes ───────────────────────────────────────────────
// RLS (`group_members_insert` / `group_members_update`, migration 015) is the
// only gate: WITH CHECK/USING (am_i_super_admin() OR am_i_group_admin(group_id)).
// No Edge Function or RPC handles add-existing — invite-player only assigns
// groups at player-create time — so these go direct to PostgREST.
//
// Both follow the hardened write pattern (return=representation + a ≥1-row
// assertion + the live session token), NOT the `return=minimal` shape of
// `api.ts updateMembershipRest`, which cannot tell an RLS-filtered 0-row write
// from a success. See BACKLOG.

/**
 * TWIN: keep identical to windex-api/supabase/functions/invite-player
 * `groupMemberId()`. Matching the shape used by sync-glide-members.mjs and the
 * seed bundle keeps us from creating duplicate-by-shape rows.
 */
function groupMemberId(groupId: string, playerId: string): string {
  const safe = (x: string) => x.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  return `gm_${safe(groupId)}_${safe(playerId)}`;
}

async function restWriteCtx() {
  const { base, anonKey } = restCtx();
  const token = await getStoredAccessToken();
  if (!base) throw new Error('API base URL is not configured.');
  if (!token) throw new Error('Session expired — sign in again.');
  return {
    base,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: anonKey || token,
      Prefer: 'return=representation',
    },
  };
}

/**
 * Insert a group_members row for an existing player. Throws on any failure —
 * including a 2xx that changed no rows — so the caller can never report a
 * silent half-success.
 */
export async function addPlayerToGroup(groupId: string, playerId: string): Promise<void> {
  const { base, headers } = await restWriteCtx();
  const res = await fetch(`${base}/rest/v1/group_members`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: groupMemberId(groupId, playerId),
      group_id: groupId,
      player_id: playerId,
      role: 'member',
      is_active: 1,
      joined_at: new Date().toISOString(),
    }),
  });
  if (res.status === 409) {
    // UNIQUE(group_id, player_id) — a row appeared since the sheet loaded.
    throw new Error('They are already in this group — refresh to see them.');
  }
  if (!res.ok) throw new Error(await restError(res, 'Failed to add player to group'));
  const rows = await res.json().catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Add returned no row — check permissions and try again.');
  }
}

/**
 * Reactivate an existing (inactive) membership. Sends `is_active` ONLY: role
 * and joined_at are preserved so this reads as the same membership resuming.
 * NOTE: group_members has no updated_at column (migration 001) — sending one
 * would 400.
 */
export async function reactivateMembership(membershipId: string): Promise<void> {
  const { base, headers } = await restWriteCtx();
  const res = await fetch(
    `${base}/rest/v1/group_members?id=eq.${encodeURIComponent(membershipId)}`,
    { method: 'PATCH', headers, body: JSON.stringify({ is_active: 1 }) },
  );
  if (!res.ok) throw new Error(await restError(res, 'Failed to reactivate membership'));
  const rows = await res.json().catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) {
    // The landmine this pattern exists to catch: PostgREST returns 2xx for an
    // RLS-filtered / not-found PATCH that touched nothing.
    throw new Error('Reactivate changed no row — check permissions and try again.');
  }
}

/** Best-effort PostgREST error message extraction. */
async function restError(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text) as { message?: string };
    if (j?.message) return `${fallback}: ${j.message}`;
  } catch {
    /* fall through */
  }
  return `${fallback} (HTTP ${res.status})`;
}

export type SendInviteResult = {
  ok: boolean;
  invite_sent: boolean;
  already_had_auth: boolean;
  linked: boolean;
  player: { id: string; display_name: string; email: string | null; user_id: string | null };
  warning?: string;
};

/** send-invite Edge Function — the only send path (two-email welcome). Super-admin gated server-side. */
export async function sendInvite(playerId: string): Promise<SendInviteResult> {
  return apiFetch<SendInviteResult>('/send-invite', {
    method: 'POST',
    body: JSON.stringify({ player_id: playerId }),
  });
}

export type CreatePlayerResult = {
  player: { id: string; display_name: string; email: string | null; user_id: string | null; is_active: number };
  groups_assigned: number;
  invite_sent: boolean;
  already_had_auth: boolean;
  warning?: string;
};

/**
 * Create a player via invite-player with send_invite:false (create + group
 * assignment are atomic inside the function, with rollback). The invite is a
 * SEPARATE send-invite call so the two-email welcome is used, not
 * invite-player's legacy code-immediately email. display_name omitted → the
 * server generates it via the canonical ladder.
 */
export async function createPlayer(input: {
  full_name: string;
  email: string;
  display_name?: string;
  group_id: string;
}): Promise<CreatePlayerResult> {
  const body: Record<string, unknown> = {
    full_name: input.full_name.trim(),
    email: input.email.trim(),
    send_invite: false,
    group_assignments: [{ group_id: input.group_id, role: 'member' }],
  };
  if (input.display_name && input.display_name.trim()) body.display_name = input.display_name.trim();
  return apiFetch<CreatePlayerResult>('/invite-player', { method: 'POST', body: JSON.stringify(body) });
}

/** Copy to clipboard (PWA/web). Returns false if the clipboard API is unavailable. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const nav = (globalThis as { navigator?: { clipboard?: { writeText(t: string): Promise<void> } } }).navigator;
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}
