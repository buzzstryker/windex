/**
 * Supabase + app auth keys without @react-native-async-storage.
 * AsyncStorage's default export uses a native TurboModule that is often null on web
 * or mis-resolved, causing: "Native module is null, cannot access legacy storage".
 * This uses expo-file-system (native) and localStorage (web).
 */
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

const FILE_NAME = 'late-add-auth-kv.json';

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

function webRemove(key: string): void {
  try {
    (globalThis as unknown as { localStorage: Storage }).localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Storage shape required by @supabase/supabase-js auth */
export const authPersistence = {
  getItem: async (key: string): Promise<string | null> => {
    if (Platform.OS === 'web') {
      return webGet(key);
    }
    const map = await loadMapNative();
    return map[key] ?? null;
  },
  setItem: async (key: string, value: string): Promise<void> => {
    if (Platform.OS === 'web') {
      webSet(key, value);
      return;
    }
    const map = await loadMapNative();
    map[key] = value;
    await saveMapNative(map);
  },
  removeItem: async (key: string): Promise<void> => {
    if (Platform.OS === 'web') {
      webRemove(key);
      return;
    }
    const map = await loadMapNative();
    delete map[key];
    await saveMapNative(map);
  },
};
