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

export async function listPlayersWithMembership(groupId: string): Promise<PlayerWithMembership[]> {
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
  const playersRes = await fetch(
    `${SUPABASE_URL}/rest/v1/players?id=in.(${inList})&select=id,display_name,full_name,email,venmo_handle,photo_url,is_active`,
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
  updates: Partial<Pick<PlayerDetail, 'display_name' | 'full_name' | 'email' | 'venmo_handle' | 'is_active'>>
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
