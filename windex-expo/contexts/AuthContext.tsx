import { createClient, SupabaseClient } from '@supabase/supabase-js';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { getSupabaseAnonKey, getSupabaseUrl, hasSupabaseAuthConfig } from '@/lib/config';
import { setAccessTokenGetter, setOnUnauthorized } from '@/lib/api';
import { authPersistence } from '@/lib/authPersistence';

type AuthContextValue = {
  ready: boolean;
  signedIn: boolean;
  signInWithPassword: (email: string, password: string) => Promise<{ error: string | null }>;
  sendOtp: (email: string) => Promise<{ error: string | null }>;
  verifyOtp: (email: string, token: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function createSupabase(): SupabaseClient | null {
  const url = getSupabaseUrl();
  const key = getSupabaseAnonKey();
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      storage: authPersistence,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const supabase = useMemo(() => (hasSupabaseAuthConfig() ? createSupabase() : null), []);
  const readyRef = useRef(false);
  const signedInAtRef = useRef<number>(0);

  // Wire up the access-token getter for api.ts
  useEffect(() => {
    setAccessTokenGetter(async () => {
      if (supabase) {
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token ?? null;
      }
      return null;
    });
  }, [supabase]);

  // Auth state listener — single source of truth for signedIn + ready
  useEffect(() => {
    let cancelled = false;

    if (supabase) {
      const { data: { subscription } } = supabase.auth.onAuthStateChange(
        (_event, session) => {
          if (cancelled) return;
          const hasToken = Boolean(session?.access_token);
          setSignedIn(hasToken);
          if (hasToken) signedInAtRef.current = Date.now();
          if (!readyRef.current) {
            readyRef.current = true;
            setReady(true);
          }
        }
      );
      return () => {
        cancelled = true;
        subscription.unsubscribe();
      };
    }

    // No Supabase client — mark ready with no session
    if (!cancelled) {
      readyRef.current = true;
      setReady(true);
    }
    return () => { cancelled = true; };
  }, [supabase]);

  const signInWithPassword = useCallback(
    async (email: string, password: string) => {
      if (!supabase) return { error: 'Supabase not configured' };
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) return { error: error.message };
      return { error: null };
    },
    [supabase]
  );

  const sendOtp = useCallback(
    async (email: string) => {
      if (!supabase) return { error: 'Supabase not configured' };
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: false, emailRedirectTo: undefined },
      });
      if (error) return { error: error.message };
      return { error: null };
    },
    [supabase]
  );

  const verifyOtp = useCallback(
    async (email: string, token: string) => {
      if (!supabase) return { error: 'Supabase not configured' };
      const { data, error } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: token.trim(),
        type: 'email',
      });
      if (error) return { error: error.message };
      // Session is established — onAuthStateChange will fire SIGNED_IN
      return { error: null };
    },
    [supabase]
  );

  const signOut = useCallback(async () => {
    if (supabase) await supabase.auth.signOut();
    setSignedIn(false);
  }, [supabase]);

  // Auto-sign-out on server 401 (expired/invalid JWT).
  // 30-second grace period after sign-in: the user may spend time navigating
  // the drawer, switching groups, or loading tabs before all API calls use
  // the fresh session token. Stale in-flight requests can return 401 during
  // this window — ignore them instead of signing out.
  useEffect(() => {
    setOnUnauthorized(() => {
      const msSinceSignIn = signedInAtRef.current ? Date.now() - signedInAtRef.current : Infinity;
      if (msSinceSignIn < 30_000) return;
      signOut();
    });
  }, [signOut]);

  const value = useMemo(
    () => ({ ready, signedIn, signInWithPassword, sendOtp, verifyOtp, signOut }),
    [ready, signedIn, signInWithPassword, sendOtp, verifyOtp, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth inside AuthProvider');
  return ctx;
}
