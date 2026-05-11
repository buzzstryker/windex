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

export interface CupChampionCandidate {
  player_id: string;
  display_name: string;
  is_active: number;
}

/**
 * Candidates for the "Set Champion" dropdown — every player who has a
 * group_members row for the given group, regardless of is_active. Inactive
 * members are still valid choices because a cup may have been won by a
 * player who has since left the group.
 */
export async function listCupChampionCandidates(groupId: string): Promise<CupChampionCandidate[]> {
  const membersRes = await fetch(
    `${SUPABASE_URL}/rest/v1/group_members?group_id=eq.${encodeURIComponent(groupId)}&select=player_id,is_active`,
    { headers: restHeaders() }
  );
  if (!membersRes.ok) {
    const body = await membersRes.text().catch(() => '');
    throw new Error(`Failed to load group members (${membersRes.status}): ${body}`);
  }
  const members: { player_id: string; is_active: number }[] = await membersRes.json();
  if (members.length === 0) return [];

  const ids = Array.from(new Set(members.map((m) => m.player_id)));
  const inList = ids.map((id) => `"${id}"`).join(',');
  const playersRes = await fetch(
    `${SUPABASE_URL}/rest/v1/players?id=in.(${inList})&select=id,display_name`,
    { headers: restHeaders() }
  );
  if (!playersRes.ok) {
    const body = await playersRes.text().catch(() => '');
    throw new Error(`Failed to load player details (${playersRes.status}): ${body}`);
  }
  const players: { id: string; display_name: string }[] = await playersRes.json();
  const nameMap = new Map(players.map((p) => [p.id, p.display_name]));

  // Highest is_active wins for the dropdown row's "active" flag (a player
  // could in theory have stale duplicate group_members rows; this collapses
  // them).
  const activeMap = new Map<string, number>();
  for (const m of members) {
    const prior = activeMap.get(m.player_id) ?? 0;
    if (m.is_active > prior) activeMap.set(m.player_id, m.is_active);
  }

  return ids
    .map((id) => {
      const display_name = nameMap.get(id);
      if (!display_name) return null;
      return {
        player_id: id,
        display_name,
        is_active: activeMap.get(id) ?? 0,
      };
    })
    .filter((x): x is CupChampionCandidate => x !== null)
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
}

export interface PlayerNames {
  display_name: string;
  full_name: string | null;
}

/**
 * Fetch display + full names for an arbitrary set of player IDs — used to
 * resolve cup_champion_player_id values in the page's seasons table when
 * the historical champion may no longer be a current group member (e.g.
 * left the group between winning the cup and now).
 *
 * Callers pick which name to render. The Cup Champions table renders
 * `full_name` (with fallback to display_name when null); the player-picker
 * dropdown intentionally renders `display_name` since admins recognize
 * players by their nicknames.
 */
export async function getPlayerNames(playerIds: string[]): Promise<Map<string, PlayerNames>> {
  const unique = Array.from(new Set(playerIds.filter((id): id is string => !!id)));
  if (unique.length === 0) return new Map();
  const inList = unique.map((id) => `"${id}"`).join(',');
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/players?id=in.(${inList})&select=id,display_name,full_name`,
    { headers: restHeaders() }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to load player names (${res.status}): ${body}`);
  }
  const rows: { id: string; display_name: string; full_name: string | null }[] = await res.json();
  return new Map(rows.map((r) => [r.id, { display_name: r.display_name, full_name: r.full_name }]));
}

/**
 * PATCH a season row to set or clear the Cup Champion + optional notes.
 *
 * RLS: seasons_update from migration 015 gates UPDATE to
 *   am_i_super_admin() OR am_i_group_admin(group_id).
 *
 * updated_at: seasons has no auto-bump trigger, so we set it explicitly
 * here. Mirrors the pattern in updatePlayer / updatePlayerRest.
 *
 * Pass `playerId: null` to clear the champion. `notes` is sent verbatim
 * (NULL clears the notes column; empty string is stored as empty string,
 * which the UI distinguishes by treating only NULL as "no note").
 */
export async function setSeasonChampion(
  seasonId: string,
  playerId: string | null,
  notes: string | null,
): Promise<void> {
  const body = {
    cup_champion_player_id: playerId,
    cup_champion_notes: notes,
    updated_at: new Date().toISOString(),
  };
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/seasons?id=eq.${encodeURIComponent(seasonId)}`,
    {
      method: 'PATCH',
      headers: restHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: { message?: string; details?: string } | null = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
    const msg = parsed?.message ?? parsed?.details ?? text ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
}
