/**
 * User-preference KV store. Same web/native split as `authPersistence`,
 * separate file so app prefs don't collide with Supabase auth keys.
 *
 * Used for: persisted "selected group" per user_id (spec: phone group picker).
 */
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

const FILE_NAME = 'windex-user-prefs.json';

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

function webGet(key: string): string | null {
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      return (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(key);
    }
  } catch {
    /* private mode etc. */
  }
  return null;
}

function webSet(key: string, value: string): void {
  try {
    (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

const PREFIX = 'windex.userPref.';

export const userPrefs = {
  getItem: async (key: string): Promise<string | null> => {
    if (Platform.OS === 'web') return webGet(PREFIX + key);
    const map = await loadMapNative();
    return map[key] ?? null;
  },
  setItem: async (key: string, value: string): Promise<void> => {
    if (Platform.OS === 'web') {
      webSet(PREFIX + key, value);
      return;
    }
    const map = await loadMapNative();
    map[key] = value;
    await saveMapNative(map);
  },
};

/** Storage key for the user's last manually-selected group, namespaced by user_id. */
export function selectedGroupKey(userId: string): string {
  return `selectedGroupId:${userId}`;
}
