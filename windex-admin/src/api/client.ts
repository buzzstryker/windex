/**
 * API client for Windex (windex-api).
 * Base URL from env; all requests use Bearer JWT when token is set.
 * Assumes windex-api Edge Functions base: /functions/v1
 */
const BASE =
  typeof import.meta.env !== 'undefined' && import.meta.env.VITE_LATE_ADD_API_URL
    ? import.meta.env.VITE_LATE_ADD_API_URL
    : 'https://ftmqzxykwcccocogkjhc.supabase.co/functions/v1';

const STORAGE_KEY = 'late_add_admin_jwt';

const ANON_KEY =
  typeof import.meta.env !== 'undefined' && import.meta.env.VITE_SUPABASE_ANON_KEY
    ? import.meta.env.VITE_SUPABASE_ANON_KEY
    : null;

let authToken: string | null =
  (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(STORAGE_KEY)) || null;

export function setAuthToken(token: string | null) {
  authToken = token;
  if (typeof sessionStorage !== 'undefined') {
    if (token) sessionStorage.setItem(STORAGE_KEY, token);
    else sessionStorage.removeItem(STORAGE_KEY);
  }
}

export function getAuthToken(): string | null {
  return authToken;
}

export class SessionExpiredError extends Error {
  constructor() {
    super('Your admin session has expired. Please sign in again.');
    this.name = 'SessionExpiredError';
  }
}

/** Decode a JWT's `exp` claim (seconds since epoch). Returns null if unparseable. */
function jwtExpSeconds(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/** True when there is no token, or the token is expired (5s clock skew). */
export function isSessionExpired(): boolean {
  if (!authToken) return true;
  const exp = jwtExpSeconds(authToken);
  if (exp === null) return true; // can't verify expiry → treat as unusable for writes
  return Date.now() >= exp * 1000 - 5000;
}

/**
 * Returns a live (present, unexpired) user JWT for a MUTATION, or throws
 * SessionExpiredError. Never falls back to the anon key: a write must run as a
 * real user so RLS applies — running as anon silently affects 0 rows and, with
 * return=minimal, looks like success (the player-name save bug). On expiry we
 * clear the stale token and bounce to /login so the admin re-authenticates.
 */
export function requireLiveSession(): string {
  if (isSessionExpired()) {
    setAuthToken(null);
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login?reason=session-expired';
    }
    throw new SessionExpiredError();
  }
  return authToken as string;
}

/**
 * Headers for a MUTATION against PostgREST. Uses the live user JWT (never the
 * anon fallback) so RLS is enforced; still sends the anon apikey for the
 * gateway. Reads keep their own anon-capable headers — "continue without
 * token" browsing stays intact.
 */
export function writeHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = requireLiveSession();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...(ANON_KEY ? { apikey: ANON_KEY } : {}),
    ...extra,
  };
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  const token = authToken ?? ANON_KEY;
  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  }
  if (ANON_KEY) {
    (headers as Record<string, string>)['apikey'] = ANON_KEY;
  }
  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) {
      setAuthToken(null);
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // use text as message
    }
    const msg = (body as { error?: string })?.error ?? text;
    const withPath = res.status === 404 && path ? `Endpoint not implemented (404): ${path}. Add in windex-api or use PostgREST.` : msg;
    throw new ApiError(res.status, withPath, body, path);
  }
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
    public path?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
