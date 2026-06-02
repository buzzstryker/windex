import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';

import { Header } from '@/components/Header';
import { Colors } from '@/constants/theme';
import { useDrawer } from '@/contexts/DrawerContext';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { getPlayerNames, getStoredAccessToken, type PlayerNames } from '@/lib/api';
import { getApiBase, getSupabaseAnonKey } from '@/lib/config';
import { setRealtimeAuth, supabaseRealtime } from '@/lib/supabase';

const ROOM_ID = 'global';
const PAGE = 50;

type Message = {
  id: string;
  room_id: string;
  author_player_id: string;
  body: string | null;
  attachment_url: string | null;
  created_at: string;
  deleted_at: string | null;
};

const MESSAGE_SELECT =
  'id,room_id,author_player_id,body,attachment_url,created_at,deleted_at';

/** Decode the `sub` (user id) claim from a Supabase JWT. Null on any failure.
 *  Mirrors userIdFromJwt in lib/userEvents.ts (not exported there). */
function userIdFromJwt(token: string): string | null {
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

function restBase(): string {
  return getApiBase().replace(/\/functions\/v1\/?$/, '');
}

async function authHeaders(): Promise<Record<string, string> | null> {
  const token = await getStoredAccessToken();
  if (!token) return null;
  const anonKey = getSupabaseAnonKey();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    apikey: anonKey || token,
  };
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`;
}

function displayName(names: Map<string, PlayerNames>, playerId: string): string {
  const n = names.get(playerId);
  return n?.full_name || n?.display_name || '—';
}

/** Merge fetched rows into existing list, de-duped by id, kept created_at DESC. */
function mergeDesc(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return Array.from(byId.values()).sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0
  );
}

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const colors = Colors[useColorScheme() ?? 'light'];
  const { openDrawer } = useDrawer();

  // Messages are stored newest-first (created_at DESC); the FlatList is
  // `inverted`, so index 0 renders at the bottom → newest at bottom.
  const [messages, setMessages] = useState<Message[]>([]);
  const [names, setNames] = useState<Map<string, PlayerNames>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const channelRef = useRef<ReturnType<NonNullable<typeof supabaseRealtime>['channel']> | null>(null);
  const authorIdRef = useRef<string | null>(null); // deterministic single player id, cached for the session
  const loadingOlderRef = useRef(false);
  const hasMoreRef = useRef(true);

  // Resolve any author ids we don't have names for yet.
  const resolveNames = useCallback(async (rows: Message[]) => {
    const missing = rows
      .map((r) => r.author_player_id)
      .filter((id) => id && !names.has(id));
    if (missing.length === 0) return;
    const fetched = await getPlayerNames(missing);
    if (fetched.size === 0) return;
    setNames((prev) => {
      const next = new Map(prev);
      fetched.forEach((v, k) => next.set(k, v));
      return next;
    });
  }, [names]);

  // Latest PAGE messages (initial load and gap-fill on resubscribe/foreground).
  const loadLatest = useCallback(async (mode: 'replace' | 'merge') => {
    const headers = await authHeaders();
    if (!headers) {
      setLoading(false);
      return;
    }
    try {
      const url =
        `${restBase()}/rest/v1/messages?room_id=eq.${ROOM_ID}&deleted_at=is.null` +
        `&order=created_at.desc&limit=${PAGE}&select=${MESSAGE_SELECT}`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`${res.status}`);
      const rows: Message[] = await res.json();
      setMessages((prev) => (mode === 'replace' ? rows : mergeDesc(prev, rows)));
      if (mode === 'replace') {
        hasMoreRef.current = rows.length === PAGE;
      }
      void resolveNames(rows);
      setError(null);
    } catch {
      if (mode === 'replace') setError('Could not load messages.');
    } finally {
      setLoading(false);
    }
  }, [resolveNames]);

  // Older page: fetch PAGE messages created before the oldest we hold.
  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current || !hasMoreRef.current) return;
    const oldest = messages[messages.length - 1];
    if (!oldest) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const headers = await authHeaders();
      if (!headers) return;
      const url =
        `${restBase()}/rest/v1/messages?room_id=eq.${ROOM_ID}&deleted_at=is.null` +
        `&created_at=lt.${encodeURIComponent(oldest.created_at)}` +
        `&order=created_at.desc&limit=${PAGE}&select=${MESSAGE_SELECT}`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`${res.status}`);
      const rows: Message[] = await res.json();
      setMessages((prev) => mergeDesc(prev, rows));
      hasMoreRef.current = rows.length === PAGE;
      void resolveNames(rows);
    } catch {
      /* leave hasMore as-is; user can scroll again to retry */
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [messages, resolveNames]);

  // Deterministic author id: earliest-created player record for this user.
  const ensureAuthorId = useCallback(async (): Promise<string | null> => {
    if (authorIdRef.current) return authorIdRef.current;
    const headers = await authHeaders();
    const token = await getStoredAccessToken();
    if (!headers || !token) return null;
    const uid = userIdFromJwt(token);
    if (!uid) return null;
    try {
      const url =
        `${restBase()}/rest/v1/players?user_id=eq.${uid}` +
        `&select=id&order=created_at.asc&limit=1`;
      const res = await fetch(url, { headers });
      if (!res.ok) return null;
      const rows: { id: string }[] = await res.json();
      authorIdRef.current = rows[0]?.id ?? null;
      return authorIdRef.current;
    } catch {
      return null;
    }
  }, []);

  // Realtime INSERT handler — prepend (DESC) and de-dupe against optimistic send.
  const onInsert = useCallback((row: Message) => {
    if (!row || row.room_id !== ROOM_ID) return;
    setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [row, ...prev]));
    void resolveNames([row]);
  }, [resolveNames]);

  const subscribe = useCallback(async () => {
    if (!supabaseRealtime || channelRef.current) return;
    setRealtimeAuth(await getStoredAccessToken()); // belt-and-suspenders: fresh token at subscribe time
    const channel = supabaseRealtime
      .channel(`messages:${ROOM_ID}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${ROOM_ID}` },
        (payload) => onInsert(payload.new as Message)
      )
      .subscribe();
    channelRef.current = channel;
  }, [onInsert]);

  const unsubscribe = useCallback(() => {
    if (supabaseRealtime && channelRef.current) {
      supabaseRealtime.removeChannel(channelRef.current);
    }
    channelRef.current = null;
  }, []);

  // Initial load on mount.
  useEffect(() => {
    void loadLatest('replace');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Channel lifecycle: subscribe on focus, tear down on blur/unmount, and
  // resubscribe + gap-fill on app foreground (the OS suspends the socket on
  // background, and realtime is not guaranteed delivery across that gap).
  useFocusEffect(
    useCallback(() => {
      void subscribe();
      const appSub = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          void subscribe();
          void loadLatest('merge');
        } else {
          unsubscribe();
        }
      });
      return () => {
        appSub.remove();
        unsubscribe();
      };
    }, [subscribe, unsubscribe, loadLatest])
  );

  const send = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    const authorId = await ensureAuthorId();
    if (!authorId) {
      setError('No player profile found for your account.');
      setSending(false);
      return;
    }
    const headers = await authHeaders();
    if (!headers) {
      setError('Sign in to send messages.');
      setSending(false);
      return;
    }
    const optimistic: Message = {
      id: crypto.randomUUID(),
      room_id: ROOM_ID,
      author_player_id: authorId,
      body: trimmed,
      attachment_url: null,
      created_at: new Date().toISOString(),
      deleted_at: null,
    };
    // Optimistic append; realtime echo de-dupes by id.
    setMessages((prev) => [optimistic, ...prev]);
    setText('');
    void resolveNames([optimistic]);
    try {
      const res = await fetch(`${restBase()}/rest/v1/messages`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({
          id: optimistic.id,
          room_id: ROOM_ID,
          body: trimmed,
          author_player_id: authorId,
        }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
    } catch {
      // Roll back the optimistic row and restore the draft.
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setText(trimmed);
      setError('Message failed to send.');
    } finally {
      setSending(false);
    }
  }, [text, sending, ensureAuthorId, resolveNames]);

  const renderItem = useCallback(
    ({ item }: { item: Message }) => (
      <View style={styles.row}>
        <Text style={[styles.author, { color: colors.tint }]} numberOfLines={1}>
          {displayName(names, item.author_player_id)}
          <Text style={[styles.time, { color: colors.icon }]}>  {formatTime(item.created_at)}</Text>
        </Text>
        <Text style={[styles.body, { color: item.deleted_at ? colors.icon : colors.text }]}>
          {item.deleted_at ? '[deleted]' : item.body}
        </Text>
      </View>
    ),
    [names, colors]
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Header title="Chat" onMenuPress={openDrawer} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top + 56}
      >
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.tint} />
          </View>
        ) : (
          <FlatList
            data={messages}
            inverted
            keyExtractor={(m) => m.id}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            onEndReached={loadOlder}
            onEndReachedThreshold={0.3}
            ListEmptyComponent={
              <View style={styles.center}>
                <Text style={{ color: colors.icon }}>No messages yet. Say hello.</Text>
              </View>
            }
            ListFooterComponent={
              loadingOlder ? (
                <View style={styles.olderSpinner}>
                  <ActivityIndicator color={colors.icon} />
                </View>
              ) : null
            }
          />
        )}

        {error ? (
          <Text style={[styles.error, { color: colors.negative }]}>{error}</Text>
        ) : null}

        <View
          style={[
            styles.composer,
            { borderTopColor: colors.border, backgroundColor: colors.card, paddingBottom: insets.bottom || 8 },
          ]}
        >
          <TextInput
            style={[styles.input, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]}
            value={text}
            onChangeText={setText}
            placeholder="Message"
            placeholderTextColor={colors.icon}
            multiline
          />
          <Pressable
            onPress={send}
            disabled={sending || text.trim().length === 0}
            style={[
              styles.send,
              { backgroundColor: colors.tint, opacity: sending || text.trim().length === 0 ? 0.5 : 1 },
            ]}
          >
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 40, transform: [{ scaleY: -1 }] },
  listContent: { paddingHorizontal: 16, paddingVertical: 12 },
  row: { marginVertical: 6 },
  author: { fontSize: 13, fontWeight: '600' },
  time: { fontSize: 11, fontWeight: '400' },
  body: { fontSize: 15, lineHeight: 20, marginTop: 1 },
  olderSpinner: { paddingVertical: 12 },
  error: { textAlign: 'center', paddingVertical: 6, fontSize: 13 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 40,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 15,
  },
  send: { borderRadius: 20, paddingHorizontal: 18, height: 40, alignItems: 'center', justifyContent: 'center' },
  sendText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
});
