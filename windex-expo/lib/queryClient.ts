/**
 * Leaderboard data cache: one TanStack QueryClient, persisted to device storage
 * so the leaderboard renders from cache on app open and revalidates in the
 * background (stale-while-revalidate).
 *
 * Expiry is per entry, not global (persister maxAge is Infinity):
 *   - a CLOSED season's standings never expire — they are a frozen snapshot
 *     (migration 059) and change only if an admin reopens the season, which the
 *     bootstrap's seasons[].closed_at reveals (see GroupContext).
 *   - everything else is dropped from the restored cache once its data is older
 *     than OPEN_MAX_AGE_MS, so the screen falls back to the spinner rather than
 *     showing week-old open-season standings.
 *
 * Keys live in lib/leaderboardData.ts. Bump CACHE_SCHEMA_VERSION whenever a
 * cached payload's shape changes: the persister discards a cache written under
 * a different buster.
 */
import { focusManager, QueryClient, type Query } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { AppState, Platform } from 'react-native';

import { queryPersistence } from './queryPersistence';

export const CACHE_SCHEMA_VERSION = '1';

/** Open-season (and every non-snapshot) entry: shown from cache for up to 7 days. */
export const OPEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** When this JS session started. Data updated before it came from the device cache. */
export const SESSION_START_MS = Date.now();

/** Query-key roots this cache owns; only these are written to disk. */
export const CACHED_ROOTS = new Set(['bootstrap', 'season', 'allTime']);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: OPEN_MAX_AGE_MS,
      retry: 1,
    },
  },
});

export const queryPersister = createAsyncStoragePersister({
  storage: queryPersistence,
  key: 'windex.queryCache.v1',
  throttleTime: 1000,
});

/** A closed season's snapshot: never stale, never expired. */
export function isPermanentQuery(query: Query): boolean {
  if (query.queryKey[0] !== 'season') return false;
  const data = query.state.data as { closed_at?: string | null } | undefined;
  return !!data?.closed_at;
}

/** Called once after the persisted cache is restored: drop expired entries. */
export function pruneExpiredQueries(): void {
  const now = Date.now();
  for (const q of queryClient.getQueryCache().getAll()) {
    if (isPermanentQuery(q)) continue;
    if (now - q.state.dataUpdatedAt > OPEN_MAX_AGE_MS) queryClient.removeQueries({ queryKey: q.queryKey, exact: true });
  }
}

/** Sign-out: wipe the cache from memory and from the device. */
export async function clearQueryCache(): Promise<void> {
  queryClient.clear();
  try {
    await queryPersister.removeClient();
  } catch {
    /* storage unavailable — memory is already clear */
  }
}

// Native: refetch-on-focus follows the app coming back to the foreground. Web
// already uses visibilitychange, which is what an installed PWA resume fires.
if (Platform.OS !== 'web') {
  focusManager.setEventListener((handleFocus) => {
    const sub = AppState.addEventListener('change', (state) => handleFocus(state === 'active'));
    return () => sub.remove();
  });
}
