import { apiFetch, ApiError, getAuthToken } from './client';

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

export interface PlayerDetail {
  id: string;
  display_name: string;
  full_name: string | null;
  email: string | null;
  venmo_handle: string | null;
  photo_url: string | null;
  is_active: number;
  /**
   * Non-null = player retired/resigned at this time (migration 029).
   * Single-axis retirement: is_active stays 1 so history/standings keep
   * showing them; only operational lists filter on retired_at.
   */
  retired_at: string | null;
  /**
   * auth.users.id link. NULL = player exists but has no auth account yet
   * (i.e., eligible for an OTP invite via the send-invite Edge Function).
   */
  user_id: string | null;
}

export interface GroupMembership {
  id: string;
  group_id: string;
  player_id: string;
  role: string;
  is_active: number;
}

export interface PlayerWithMembership extends PlayerDetail {
  membership: GroupMembership;
}

/**
 * List every player in the table — used by the Create Group admin picker.
 * RLS (`players_select` in migration 015) is `USING (true)` for authenticated
 * users, so any signed-in admin can read this. Sorted by display_name.
 * Retired players (migration 029) are excluded — they can't be added to a
 * group until unretired from the Players page.
 */
export async function listAllPlayers(): Promise<PlayerDetail[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/players?retired_at=is.null&select=id,display_name,full_name,email,venmo_handle,photo_url,is_active,retired_at,user_id&order=display_name.asc`,
    { headers: headers() }
  );
  if (!res.ok) throw new Error(`Failed to fetch players: ${res.status}`);
  return res.json();
}

/**
 * Members of a group joined to their player record. `opts.retired` selects
 * which retirement bucket (migration 029): default/false = operational view
 * (retired_at IS NULL); true = the Retired tab (retired_at IS NOT NULL).
 * The retirement filter is applied on the players query, so a member whose
 * player is in the other bucket is naturally dropped from the result.
 */
export async function listPlayersWithMembership(
  groupId: string,
  opts?: { retired?: boolean }
): Promise<PlayerWithMembership[]> {
  // Fetch group_members for this group
  const membersRes = await fetch(
    `${SUPABASE_URL}/rest/v1/group_members?group_id=eq.${encodeURIComponent(groupId)}&select=id,group_id,player_id,role,is_active`,
    { headers: headers() }
  );
  if (!membersRes.ok) throw new Error(`Failed to fetch members: ${membersRes.status}`);
  const members: GroupMembership[] = await membersRes.json();

  if (members.length === 0) return [];

  // Fetch player details for all member player_ids
  const playerIds = members.map((m) => m.player_id);
  const inList = playerIds.map((id) => `"${id}"`).join(',');
  const retiredFilter = opts?.retired ? '&retired_at=not.is.null' : '&retired_at=is.null';
  const playersRes = await fetch(
    `${SUPABASE_URL}/rest/v1/players?id=in.(${inList})${retiredFilter}&select=id,display_name,full_name,email,venmo_handle,photo_url,is_active,retired_at,user_id`,
    { headers: headers() }
  );
  if (!playersRes.ok) throw new Error(`Failed to fetch players: ${playersRes.status}`);
  const players: PlayerDetail[] = await playersRes.json();

  const playerMap = new Map(players.map((p) => [p.id, p]));

  return members
    .map((m) => {
      const p = playerMap.get(m.player_id);
      if (!p) return null;
      return { ...p, membership: m };
    })
    .filter((x): x is PlayerWithMembership => x !== null)
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
}

/**
 * PATCH a players row by id. Permissions are enforced by RLS
 * (`players_update` in migration 015): super admin can update any row,
 * the owning auth user can update their own. The previous client-side
 * `user_id=eq.<currentUserId>` filter was redundant defense that became
 * harmful after migration 020 made `user_id` nullable — pending players
 * with `user_id IS NULL` would silently fail to update.
 */
export async function updatePlayer(
  playerId: string,
  updates: Partial<Pick<PlayerDetail, 'display_name' | 'full_name' | 'email' | 'venmo_handle' | 'is_active' | 'retired_at'>>
): Promise<void> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/players?id=eq.${encodeURIComponent(playerId)}`,
    {
      method: 'PATCH',
      headers: headers({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ ...updates, updated_at: new Date().toISOString() }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to update player: ${res.status} ${text}`);
  }
}

export async function updateMembership(
  membershipId: string,
  updates: Partial<Pick<GroupMembership, 'role' | 'is_active'>>
): Promise<void> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/group_members?id=eq.${encodeURIComponent(membershipId)}`,
    {
      method: 'PATCH',
      headers: headers({ Prefer: 'return=minimal' }),
      body: JSON.stringify(updates),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to update membership: ${res.status} ${text}`);
  }
}

// =============================================================================
// admin-update-user-email Edge Function
// =============================================================================

export interface AdminUpdateUserEmailResponse {
  ok: true;
  user_id: string;
  email: string;
  /** Number of players rows whose email mirror was synced (a user can have several). */
  players_synced: number;
}

/**
 * POST /admin-update-user-email — super-admin only (gated server-side via the
 * am_i_super_admin() RPC). Changes the TARGET player's auth login identity
 * (auth.users.email, email_confirm:true so it's immediate) and syncs
 * players.email across every row for that auth user. Use this — NOT a plain
 * players.email PATCH — whenever a LINKED player's email changes, because the
 * email is their OTP login identity.
 *
 * Surfaces the function's real errors. The shared apiFetch rewrites any 404
 * into a generic "endpoint not implemented" message, so we recover the
 * function's true error (e.g. "Player not found") from the parsed body.
 */
export async function adminUpdateUserEmail(
  playerId: string,
  email: string
): Promise<AdminUpdateUserEmailResponse> {
  try {
    return await apiFetch<AdminUpdateUserEmailResponse>('/admin-update-user-email', {
      method: 'POST',
      body: JSON.stringify({ player_id: playerId, email }),
    });
  } catch (e) {
    if (e instanceof ApiError) {
      const real = (e.body as { error?: string } | undefined)?.error;
      if (real) throw new ApiError(e.status, real, e.body, e.path);
    }
    throw e;
  }
}

// =============================================================================
// invite-player Edge Function
// =============================================================================

export interface GroupAssignment {
  group_id: string;
  role: 'admin' | 'member';
}

export interface InvitePlayerInput {
  display_name: string;
  email: string;
  send_invite: boolean;
  group_assignments: GroupAssignment[];
}

export interface InvitePlayerResponse {
  player: {
    id: string;
    display_name: string;
    email: string | null;
    user_id: string | null;
    is_active: number;
  };
  groups_assigned: number;
  invite_sent: boolean;
  already_had_auth: boolean;
}

export class DuplicatePlayerEmailError extends Error {
  constructor(public existingPlayerId: string) {
    super('Player with this email already exists');
    this.name = 'DuplicatePlayerEmailError';
  }
}

/**
 * Calls POST /invite-player. Translates the 409 duplicate-email response
 * into a typed DuplicatePlayerEmailError so the UI can offer "view existing
 * player" without parsing strings.
 */
export async function invitePlayer(input: InvitePlayerInput): Promise<InvitePlayerResponse> {
  try {
    return await apiFetch<InvitePlayerResponse>('/invite-player', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      const body = e.body as { existing_player_id?: string } | undefined;
      if (body?.existing_player_id) throw new DuplicatePlayerEmailError(body.existing_player_id);
    }
    throw e;
  }
}

// =============================================================================
// send-invite Edge Function
// =============================================================================

export interface SendInviteResponse {
  ok: true;
  /** True if an invite email was sent. False when the auth user already existed and we just linked. */
  invite_sent: boolean;
  /** True if the email already had an auth.users row before this call. */
  already_had_auth: boolean;
  /**
   * True if players.user_id is populated after the call. Mainly used to
   * surface trigger failures (e.g. email casing/whitespace mismatch) — the
   * link_player_on_auth_signup trigger from migration 020 should always
   * fire on invite, but if it didn't we want to know rather than lie.
   */
  linked: boolean;
  player: {
    id: string;
    display_name: string;
    email: string | null;
    user_id: string | null;
  };
}

export class PlayerAlreadyLinkedError extends Error {
  constructor(public userId: string) {
    super('Player is already linked to an auth user');
    this.name = 'PlayerAlreadyLinkedError';
  }
}

/**
 * POST /send-invite — sends an OTP invite for an existing player that has no
 * auth.users row. Super-admin gated server-side. Translates the 409
 * already-linked response into a typed error so the UI can prompt for a refresh.
 */
export async function sendInvite(playerId: string): Promise<SendInviteResponse> {
  try {
    return await apiFetch<SendInviteResponse>('/send-invite', {
      method: 'POST',
      body: JSON.stringify({ player_id: playerId }),
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      const body = e.body as { user_id?: string } | undefined;
      if (body?.user_id) throw new PlayerAlreadyLinkedError(body.user_id);
    }
    throw e;
  }
}

// =============================================================================
// Player auth status (migration 027)
// =============================================================================

/**
 * Per-player onboarding state row returned by the `get_players_auth_status()`
 * RPC. The RPC joins `players` to `auth.users` server-side (super-admin
 * gated) so the UI can decide which affordance to render per row without
 * needing direct access to the auth schema.
 */
export interface PlayerAuthStatus {
  player_id: string;
  has_signed_in: boolean;
  invited_at: string | null;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
}

/**
 * Calls the `get_players_auth_status()` RPC from migration 027. Returns a
 * Map keyed by player_id for O(1) lookup from the row-render path. Returns
 * an empty Map if the caller isn't a super admin (the RPC gates internally).
 */
export async function getPlayersAuthStatus(): Promise<Map<string, PlayerAuthStatus>> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/get_players_auth_status`,
    {
      method: 'POST',
      headers: headers(),
      body: '{}',
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`get_players_auth_status failed (${res.status}): ${text}`);
  }
  const rows: PlayerAuthStatus[] = await res.json();
  return new Map(rows.map((r) => [r.player_id, r]));
}
