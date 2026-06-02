/**
 * Dedicated supabase-js client used ONLY for Realtime (postgres_changes on
 * `messages`). The app's data layer is otherwise raw PostgREST fetch
 * (lib/api.ts, lib/userEvents.ts); the auth/session client lives inside
 * AuthContext.tsx and is intentionally not exposed.
 *
 * Why a second, session-less client?
 *   AuthContext's client owns the session (persistSession + autoRefreshToken,
 *   custom authPersistence storage). If this client also persisted and
 *   auto-refreshed against the same stored session, the two would race to
 *   rotate the single refresh token and could invalidate each other — a known
 *   supabase-js multi-client footgun. So this client does ZERO session
 *   management: it holds a websocket and whatever JWT we hand it.
 *
 * Token lifecycle:
 *   AuthContext is the single source of truth. Its onAuthStateChange handler
 *   calls setRealtimeAuth(session.access_token) on every relevant event
 *   (INITIAL_SESSION, SIGNED_IN, TOKEN_REFRESHED, SIGNED_OUT), so the realtime
 *   socket always carries a fresh token and the channel never goes deaf after
 *   a refresh. Screens may also call setRealtimeAuth right before subscribing
 *   (belt-and-suspenders) using a fresh token from getStoredAccessToken().
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';

import { getSupabaseAnonKey, getSupabaseUrl, hasSupabaseAuthConfig } from './config';

export const supabaseRealtime: SupabaseClient | null = hasSupabaseAuthConfig()
  ? createClient(getSupabaseUrl(), getSupabaseAnonKey(), {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    })
  : null;

/**
 * Apply (or clear) the user JWT on the realtime socket. Updates the token on
 * the websocket and pushes it to already-joined channels, so a live
 * subscription survives a token rotation. Pass null on sign-out.
 */
export function setRealtimeAuth(token: string | null): void {
  if (!supabaseRealtime) return;
  supabaseRealtime.realtime.setAuth(token ?? '');
}
