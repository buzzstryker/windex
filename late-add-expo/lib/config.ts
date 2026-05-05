/**
 * Windex API base (Edge Functions), same as late-add-admin VITE_LATE_ADD_API_URL.
 * Example: https://xxxx.supabase.co/functions/v1
 */
export function getApiBase(): string {
  const explicit = process.env.EXPO_PUBLIC_LATE_ADD_API_URL?.replace(/\/$/, '');
  if (explicit) return explicit;
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
  if (supabaseUrl) return `${supabaseUrl}/functions/v1`;
  return '';
}

export function getSupabaseUrl(): string {
  return process.env.EXPO_PUBLIC_SUPABASE_URL?.replace(/\/$/, '') ?? '';
}

export function getSupabaseAnonKey(): string {
  return process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
}

export function hasSupabaseAuthConfig(): boolean {
  return Boolean(getSupabaseUrl() && getSupabaseAnonKey());
}
