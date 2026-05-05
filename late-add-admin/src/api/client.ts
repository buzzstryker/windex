/**
 * API client for Windex (late-add-api).
 * Base URL from env; all requests use Bearer JWT when token is set.
 * Assumes late-add-api Edge Functions base: /functions/v1
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
    const withPath = res.status === 404 && path ? `Endpoint not implemented (404): ${path}. Add in late-add-api or use PostgREST.` : msg;
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
