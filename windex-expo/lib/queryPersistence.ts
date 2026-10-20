/**
 * Storage for the persisted TanStack Query cache (lib/queryClient.ts). Same
 * web/native split as `authPersistence` and `userPrefs` — localStorage on web,
 * a JSON file under expo-file-system on native — in its own file so a large
 * cache write never rewrites the auth or prefs maps.
 *
 * On an installed iOS PWA this is the home-screen app's localStorage, the same
 * store that holds the Supabase session: if iOS evicts it, the user signs in
 * again and gets a cold load, never someone else's cached data.
 */
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

const FILE_NAME = 'windex-query-cache.json';

async function loadMapNative(): Promise<Record<string, string>> {
  const base = FileSystem.documentDirectory;
  if (!base) return {};
  const path = `${base}${FILE_NAME}`;
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return {};
    const raw = await FileSystem.readAsStringAsync(path);
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

async function saveMapNative(data: Record<string, string>): Promise<void> {
  const base = FileSystem.documentDirectory;
  if (!base) return;
  const path = `${base}${FILE_NAME}`;
  await FileSystem.writeAsStringAsync(path, JSON.stringify(data));
}

function webStorage(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      return (globalThis as unknown as { localStorage: Storage }).localStorage;
    }
  } catch {
    /* private mode etc. */
  }
  return null;
}

/** AsyncStorage-shaped adapter for createAsyncStoragePersister. */
export const queryPersistence = {
  getItem: async (key: string): Promise<string | null> => {
    if (Platform.OS === 'web') {
      try {
        return webStorage()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    }
    const map = await loadMapNative();
    return map[key] ?? null;
  },
  setItem: async (key: string, value: string): Promise<void> => {
    if (Platform.OS === 'web') {
      try {
        webStorage()?.setItem(key, value);
      } catch {
        /* quota or private mode — the cache is best-effort */
      }
      return;
    }
    const map = await loadMapNative();
    map[key] = value;
    await saveMapNative(map);
  },
  removeItem: async (key: string): Promise<void> => {
    if (Platform.OS === 'web') {
      try {
        webStorage()?.removeItem(key);
      } catch {
        /* ignore */
      }
      return;
    }
    const map = await loadMapNative();
    delete map[key];
    await saveMapNative(map);
  },
};
