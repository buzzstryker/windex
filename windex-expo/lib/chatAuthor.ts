/**
 * Shared resolution of the signed-in user's chat author identity: the
 * earliest-created player record linked to the auth user (deterministic when
 * a user owns multiple player rows). Extracted from chat.tsx so the chat
 * screen (sending) and the unread-dot provider (excluding own messages)
 * share one cached lookup.
 */
import { getStoredAccessToken } from '@/lib/api';
import { getApiBase, getSupabaseAnonKey } from '@/lib/config';

/** Decode the `sub` (user id) claim from a Supabase JWT. Null on any failure.
 *  Mirrors userIdFromJwt in lib/userEvents.ts (not exported there). */
export function userIdFromJwt(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { sub?: string };
    return payload?.sub ?? null;
  } catch {
    return null;
  }
}

let cachedAuthorId: string | null = null;
let cachedForUserId: string | null = null;

/**
 * Deterministic author id: earliest-created player record for this user.
 * Cached per auth user (keyed by JWT sub, so signing in as a different user
 * refetches). Null when signed out or no player profile exists.
 */
export async function getAuthorPlayerId(): Promise<string | null> {
  const token = await getStoredAccessToken();
  if (!token) return null;
  const uid = userIdFromJwt(token);
  if (!uid) return null;
  if (cachedAuthorId && cachedForUserId === uid) return cachedAuthorId;
  const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
  const anonKey = getSupabaseAnonKey();
  try {
    const url =
      `${base}/rest/v1/players?user_id=eq.${uid}` +
      `&select=id&order=created_at.asc&limit=1`;
    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: anonKey || token,
      },
    });
    if (!res.ok) return null;
    const rows: { id: string }[] = await res.json();
    cachedAuthorId = rows[0]?.id ?? null;
    cachedForUserId = uid;
    return cachedAuthorId;
  } catch {
    return null;
  }
}
