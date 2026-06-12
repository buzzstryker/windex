import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Image as ExpoImage } from 'expo-image';

import { Header } from '@/components/Header';
import { Colors } from '@/constants/theme';
import { useChatUnread } from '@/contexts/ChatUnreadContext';
import { useDrawer } from '@/contexts/DrawerContext';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { getPlayerNames, getStoredAccessToken, type PlayerNames } from '@/lib/api';
import { getAuthorPlayerId } from '@/lib/chatAuthor';
import { getApiBase, getSupabaseAnonKey } from '@/lib/config';
import { setRealtimeAuth, supabaseRealtime } from '@/lib/supabase';
import { setComposerBusy } from '@/lib/pwaUpdate';

const ROOM_ID = 'global';
const PAGE = 50;
const OLIVE = '#4B5E2A';
const REACTION_EMOJIS = ['👍', '😂', '🔥', '⛳', '💀'];

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

type Reaction = {
  message_id: string;
  player_id: string;
  emoji: string;
};

/** Composer attachment after the canvas pipeline: re-encoded JPEG + dims. */
type PendingImage = {
  blob: Blob;
  width: number;
  height: number;
  previewUrl: string;
};

/** Max long edge after downscale (never upscales). */
const IMAGE_MAX_EDGE = 1600;
const IMAGE_JPEG_QUALITY = 0.82;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // matches the bucket's 5 MiB cap

/**
 * Web-only canvas pipeline: decode → downscale to IMAGE_MAX_EDGE → re-encode
 * JPEG. Also normalizes anything the browser can decode (HEIC on Safari,
 * webp, png) to JPEG. Returns null if the file can't be decoded.
 */
async function processImage(file: File): Promise<{ blob: Blob; width: number; height: number } | null> {
  try {
    let source: CanvasImageSource;
    let srcW: number;
    let srcH: number;
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (bitmap) {
      source = bitmap;
      srcW = bitmap.width;
      srcH = bitmap.height;
    } else {
      // Fallback decoder for types createImageBitmap rejects.
      const objUrl = URL.createObjectURL(file);
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new window.Image();
          el.onload = () => resolve(el);
          el.onerror = reject;
          el.src = objUrl;
        });
        source = img;
        srcW = img.naturalWidth;
        srcH = img.naturalHeight;
      } finally {
        URL.revokeObjectURL(objUrl);
      }
    }
    if (!srcW || !srcH) return null;
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', IMAGE_JPEG_QUALITY)
    );
    if (!blob) return null;
    return { blob, width: w, height: h };
  } catch {
    return null;
  }
}

/** Dimensions encoded in the attachment URL fragment (#w=...&h=...). */
function parseDims(url: string): { w: number; h: number } | null {
  const m = url.match(/#w=(\d+)&h=(\d+)/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
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
  return n?.display_name || n?.full_name || 'Unknown';
}

/** Merge fetched rows into existing list, de-duped by id, kept created_at DESC. */
function mergeDesc(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return Array.from(byId.values()).sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0
  );
}

/**
 * Keyboard inset for installed iOS PWAs. A Safari tab resizes the viewport
 * (and scrolls the input into view) when the keyboard opens, so the browser
 * "just works". A standalone home-screen PWA instead OVERLAYS the keyboard
 * without resizing the layout viewport, and react-native-web's
 * KeyboardAvoidingView never reacts — leaving the composer mis-positioned and
 * stale until a gesture forces a repaint. The visualViewport API still reports
 * the keyboard in standalone mode, so we use it to compute the keyboard height
 * and pad the content; on hide, visualViewport fires 'resize' and we reset
 * (which also triggers the missing reflow). Scoped to standalone web only so
 * the already-correct browser and native paths are untouched.
 */
function useStandaloneKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const nav = navigator as Navigator & { standalone?: boolean };
    const isStandalone =
      nav.standalone === true ||
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(display-mode: standalone)').matches);
    const vv = window.visualViewport;
    if (!isStandalone || !vv) return;
    const update = () => {
      setInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const kbInset = useStandaloneKeyboardInset();
  const scheme = useColorScheme() ?? 'light';
  const colors = Colors[scheme];
  const isDark = scheme === 'dark';
  const { openDrawer } = useDrawer();
  const { markRead, setChatFocused } = useChatUnread();

  // Messages are stored newest-first (created_at DESC); the FlatList is
  // `inverted`, so index 0 renders at the bottom → newest at bottom.
  const [messages, setMessages] = useState<Message[]>([]);
  const [names, setNames] = useState<Map<string, PlayerNames>>(new Map());
  // Raw reaction rows keyed by message_id; aggregated per message at render.
  const [reactions, setReactions] = useState<Map<string, Reaction[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  // Own-message detection for bubble alignment (cached lookup, resolves once).
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null);
  useEffect(() => {
    void getAuthorPlayerId().then(setMyPlayerId);
  }, []);

  // Long-press action sheet (custom Modal — Alert/ActionSheetIOS are no-ops on
  // react-native-web). confirmDelete switches the sheet to its confirm step.
  const [sheetTarget, setSheetTarget] = useState<Message | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Non-null = sheet opens straight into "Remove your <emoji> reaction?".
  const [confirmRemoveEmoji, setConfirmRemoveEmoji] = useState<string | null>(null);
  const closeSheet = useCallback(() => {
    setSheetTarget(null);
    setConfirmDelete(false);
    setConfirmRemoveEmoji(null);
  }, []);

  // Tell the PWA updater the composer is "busy" (focused or holding unsent
  // text) so a service-worker auto-reload is deferred until it's safe — never
  // eating a half-typed message. Release on unmount (leaving the chat tab).
  useEffect(() => {
    setComposerBusy(inputFocused || text.trim().length > 0 || pendingImage != null);
  }, [inputFocused, text, pendingImage]);
  useEffect(() => () => setComposerBusy(false), []);

  const channelRef = useRef<ReturnType<NonNullable<typeof supabaseRealtime>['channel']> | null>(null);
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

  // Batch-fetch reactions for a set of message ids and replace those entries.
  const loadReactions = useCallback(async (messageIds: string[]) => {
    if (messageIds.length === 0) return;
    const headers = await authHeaders();
    if (!headers) return;
    try {
      const res = await fetch(
        `${restBase()}/rest/v1/message_reactions?message_id=in.(${messageIds.join(',')})` +
          `&select=message_id,player_id,emoji`,
        { headers }
      );
      if (!res.ok) return;
      const rows: Reaction[] = await res.json();
      setReactions((prev) => {
        const next = new Map(prev);
        for (const id of messageIds) next.set(id, []);
        for (const r of rows) {
          const list = next.get(r.message_id);
          if (list) list.push(r);
          else next.set(r.message_id, [r]);
        }
        return next;
      });
    } catch {
      /* non-fatal; realtime and the next load self-heal */
    }
  }, []);

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
      void loadReactions(rows.map((r) => r.id));
      setError(null);
    } catch {
      if (mode === 'replace') setError('Could not load messages.');
    } finally {
      setLoading(false);
    }
  }, [resolveNames, loadReactions]);

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
      void loadReactions(rows.map((r) => r.id));
    } catch {
      /* leave hasMore as-is; user can scroll again to retry */
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [messages, resolveNames, loadReactions]);

  // Record the read watermark (upsert on the (player_id, room_id) PK) and
  // clear the tab dot. Failures are non-fatal; the next focus retries.
  const markRoomRead = useCallback(async () => {
    markRead();
    const authorId = await getAuthorPlayerId();
    const headers = await authHeaders();
    if (!authorId || !headers) return;
    try {
      await fetch(`${restBase()}/rest/v1/room_reads`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          player_id: authorId,
          room_id: ROOM_ID,
          last_read_at: new Date().toISOString(),
        }),
      });
    } catch {
      /* non-fatal */
    }
  }, [markRead]);

  // Realtime INSERT handler — prepend (DESC) and de-dupe against optimistic
  // send. The channel only exists while this screen is focused, so every
  // insert seen here is "read" — advance the watermark.
  const onInsert = useCallback((row: Message) => {
    if (!row || row.room_id !== ROOM_ID) return;
    setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [row, ...prev]));
    void resolveNames([row]);
    void markRoomRead();
  }, [resolveNames, markRoomRead]);

  // Realtime UPDATE handler. A soft-delete (non-null deleted_at) vanishes the
  // row from view and prunes its orphaned reactions; any other UPDATE (none
  // exist today given the immutability trigger) replaces in place.
  const onUpdate = useCallback((row: Message) => {
    if (!row || row.room_id !== ROOM_ID) return;
    if (row.deleted_at) {
      setMessages((prev) => prev.filter((m) => m.id !== row.id));
      setReactions((prev) => {
        if (!prev.has(row.id)) return prev;
        const next = new Map(prev);
        next.delete(row.id);
        return next;
      });
      return;
    }
    setMessages((prev) => prev.map((m) => (m.id === row.id ? row : m)));
  }, []);

  // Reaction add/remove — shared by realtime events and optimistic toggles.
  // De-dupes by the (message_id, player_id, emoji) PK, so a realtime echo of
  // our own optimistic write is a no-op.
  const addReaction = useCallback((row: Reaction) => {
    if (!row?.message_id) return;
    setReactions((prev) => {
      const list = prev.get(row.message_id) ?? [];
      if (list.some((r) => r.player_id === row.player_id && r.emoji === row.emoji)) return prev;
      const next = new Map(prev);
      next.set(row.message_id, [...list, row]);
      return next;
    });
  }, []);

  const removeReaction = useCallback((row: Reaction) => {
    if (!row?.message_id) return;
    setReactions((prev) => {
      const list = prev.get(row.message_id);
      if (!list) return prev;
      const filtered = list.filter(
        (r) => !(r.player_id === row.player_id && r.emoji === row.emoji)
      );
      if (filtered.length === list.length) return prev;
      const next = new Map(prev);
      next.set(row.message_id, filtered);
      return next;
    });
  }, []);

  // Toggle own reaction: optimistic, revert on failure.
  const toggleReaction = useCallback(
    async (messageId: string, emoji: string, currentlyMine: boolean) => {
      if (!myPlayerId) return;
      const mine: Reaction = { message_id: messageId, player_id: myPlayerId, emoji };
      if (currentlyMine) removeReaction(mine);
      else addReaction(mine);
      const headers = await authHeaders();
      if (!headers) return;
      try {
        if (currentlyMine) {
          const res = await fetch(
            `${restBase()}/rest/v1/message_reactions?message_id=eq.${messageId}` +
              `&player_id=eq.${myPlayerId}&emoji=eq.${encodeURIComponent(emoji)}`,
            { method: 'DELETE', headers }
          );
          if (!res.ok) throw new Error(`${res.status}`);
        } else {
          const res = await fetch(`${restBase()}/rest/v1/message_reactions`, {
            method: 'POST',
            headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(mine),
          });
          if (!res.ok) throw new Error(`${res.status}`);
        }
      } catch {
        if (currentlyMine) addReaction(mine);
        else removeReaction(mine);
      }
    },
    [myPlayerId, addReaction, removeReaction]
  );

  // Soft-delete own message: optimistic removal from view; on failure (or no
  // auth), mergeDesc reinserts the row at its original created_at-DESC slot.
  const deleteMessage = useCallback(async (msg: Message) => {
    closeSheet();
    setMessages((prev) => prev.filter((m) => m.id !== msg.id));
    const headers = await authHeaders();
    if (!headers) {
      setMessages((prev) => mergeDesc(prev, [msg]));
      return;
    }
    try {
      const res = await fetch(`${restBase()}/rest/v1/messages?id=eq.${msg.id}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ deleted_at: new Date().toISOString() }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setReactions((prev) => {
        if (!prev.has(msg.id)) return prev;
        const next = new Map(prev);
        next.delete(msg.id);
        return next;
      });
    } catch {
      setMessages((prev) => mergeDesc(prev, [msg]));
      setError('Could not delete message.');
    }
  }, [closeSheet]);

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
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `room_id=eq.${ROOM_ID}` },
        (payload) => onUpdate(payload.new as Message)
      )
      // Reactions: unfiltered (table is chat-only; client matches by message
      // id). DELETE payloads carry PK columns only — which is the whole row.
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'message_reactions' },
        (payload) => addReaction(payload.new as Reaction)
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'message_reactions' },
        (payload) => removeReaction(payload.old as Reaction)
      )
      .subscribe();
    channelRef.current = channel;
  }, [onInsert, onUpdate, addReaction, removeReaction]);

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
      setChatFocused(true);
      void subscribe();
      void markRoomRead();
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
        setChatFocused(false);
      };
    }, [subscribe, unsubscribe, loadLatest, markRoomRead, setChatFocused])
  );

  // Web-only photo picker: imperative hidden file input (react-native-web
  // can't render a DOM <input>), canvas pipeline, thumbnail into the composer.
  const pickImage = useCallback(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const processed = await processImage(file);
      if (!processed) {
        setError('Could not read that image.');
        return;
      }
      if (processed.blob.size > IMAGE_MAX_BYTES) {
        setError('Image is too large even after compression (5 MB max).');
        return;
      }
      setError(null);
      setPendingImage((prev) => {
        if (prev) URL.revokeObjectURL(prev.previewUrl);
        return { ...processed, previewUrl: URL.createObjectURL(processed.blob) };
      });
    };
    input.click();
  }, []);

  const cancelPendingImage = useCallback(() => {
    setPendingImage((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
  }, []);

  const send = useCallback(async () => {
    const trimmed = text.trim();
    const img = pendingImage;
    if ((!trimmed && !img) || sending) return;
    setSending(true);
    setError(null);
    const authorId = await getAuthorPlayerId();
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
      body: trimmed || null,
      // Local object URL until the server row replaces it on the next merge;
      // dims ride the fragment exactly like the real URL's.
      attachment_url: img ? `${img.previewUrl}#w=${img.width}&h=${img.height}` : null,
      created_at: new Date().toISOString(),
      deleted_at: null,
    };
    // Optimistic append; realtime echo de-dupes by id.
    setMessages((prev) => [optimistic, ...prev]);
    setText('');
    setPendingImage(null);
    void resolveNames([optimistic]);
    const restore = () => {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setText(trimmed);
      setPendingImage(img);
    };
    try {
      let attachmentUrl: string | null = null;
      if (img) {
        // Upload first, then post the message referencing the public URL.
        // If the message POST fails after upload, the object orphans
        // (accepted debt, same class as delete-orphans).
        const path = `${authorId}/${crypto.randomUUID()}.jpg`;
        const up = await fetch(`${restBase()}/storage/v1/object/chat-images/${path}`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'image/jpeg' },
          body: img.blob,
        });
        if (!up.ok) throw new Error(`upload ${up.status}`);
        attachmentUrl =
          `${restBase()}/storage/v1/object/public/chat-images/${path}` +
          `#w=${img.width}&h=${img.height}`;
      }
      const res = await fetch(`${restBase()}/rest/v1/messages`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({
          id: optimistic.id,
          room_id: ROOM_ID,
          body: trimmed || null,
          attachment_url: attachmentUrl,
          author_player_id: authorId,
        }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      // Success: keep the preview object URL alive — the optimistic row
      // still references it until a gap-fill swaps in the server row.
    } catch {
      restore();
      setError('Message failed to send.');
    } finally {
      setSending(false);
    }
  }, [text, sending, pendingImage, resolveNames]);

  const renderItem = useCallback(
    ({ item, index }: { item: Message; index: number }) => {
      const isMine = myPlayerId != null && item.author_player_id === myPlayerId;
      // List is created_at DESC, so index+1 is the chronologically previous
      // message — rendered visually ABOVE this one in the inverted FlatList.
      const older = messages[index + 1];
      const authorChanged = !older || older.author_player_id !== item.author_player_id;
      const showAuthor = !isMine && authorChanged;
      // Aggregate raw reaction rows to per-emoji pills.
      const rx = reactions.get(item.id);
      const pills: { emoji: string; count: number; mine: boolean }[] = [];
      if (rx && rx.length > 0) {
        const byEmoji = new Map<string, { count: number; mine: boolean }>();
        for (const r of rx) {
          const agg = byEmoji.get(r.emoji) ?? { count: 0, mine: false };
          agg.count += 1;
          if (myPlayerId && r.player_id === myPlayerId) agg.mine = true;
          byEmoji.set(r.emoji, agg);
        }
        byEmoji.forEach((v, emoji) => pills.push({ emoji, ...v }));
      }
      return (
        <View
          style={[
            styles.row,
            isMine ? styles.rowMine : styles.rowOther,
            // In layout (pre-inversion) cells run newest→oldest top→bottom, so
            // marginBottom here becomes the visual gap to the OLDER message above.
            { marginBottom: authorChanged ? 10 : 4 },
          ]}
        >
          {showAuthor ? (
            <Text style={[styles.authorLabel, { color: colors.icon }]} numberOfLines={1}>
              {displayName(names, item.author_player_id)}
            </Text>
          ) : null}
          <Pressable
            onPress={
              item.attachment_url ? () => setLightboxUrl(item.attachment_url) : undefined
            }
            onLongPress={() => {
              setConfirmDelete(false);
              setConfirmRemoveEmoji(null);
              setSheetTarget(item);
            }}
            style={[
              styles.bubble,
              isMine
                ? styles.bubbleMine
                : { backgroundColor: isDark ? colors.card : '#E9E9EB' },
              item.attachment_url ? styles.bubbleWithImage : null,
            ]}
          >
            {item.attachment_url ? (
              <>
                {(() => {
                  const dims = parseDims(item.attachment_url);
                  // Cap to 240w x 320h at the image's aspect ratio; square
                  // fallback for rows without the fragment (hand-inserted).
                  let dw = 220;
                  let dh = 220;
                  if (dims && dims.w > 0 && dims.h > 0) {
                    const scale = Math.min(240 / dims.w, 320 / dims.h, 1);
                    dw = Math.max(1, Math.round(dims.w * scale));
                    dh = Math.max(1, Math.round(dims.h * scale));
                  }
                  return (
                    <ExpoImage
                      source={{ uri: item.attachment_url }}
                      style={{ width: dw, height: dh }}
                      contentFit="cover"
                    />
                  );
                })()}
                {item.body ? (
                  <Text
                    style={[
                      styles.bubbleText,
                      styles.captionPad,
                      isMine ? styles.bubbleTextMine : { color: isDark ? colors.text : '#1A1A1A' },
                    ]}
                  >
                    {item.body}
                  </Text>
                ) : null}
              </>
            ) : (
              <Text
                style={[
                  styles.bubbleText,
                  isMine ? styles.bubbleTextMine : { color: isDark ? colors.text : '#1A1A1A' },
                ]}
              >
                {item.body}
              </Text>
            )}
          </Pressable>
          {pills.length > 0 ? (
            <View style={styles.reactionRow}>
              {pills.map((p) => {
                // iMessage-style stack: no count; one emoji per reactor,
                // each subsequent copy peeking ~7px out from BEHIND the
                // previous (zIndex descends), capped at 3 visible layers.
                const layers = Math.min(p.count, 3);
                return (
                  <Pressable
                    key={p.emoji}
                    // Adding is one tap; removing is deliberate — tapping (or
                    // long-pressing) a pill I've reacted with opens the sheet
                    // directly in remove-confirm mode for that emoji.
                    onPress={() => {
                      if (p.mine) {
                        setConfirmDelete(false);
                        setConfirmRemoveEmoji(p.emoji);
                        setSheetTarget(item);
                      } else {
                        void toggleReaction(item.id, p.emoji, false);
                      }
                    }}
                    onLongPress={
                      p.mine
                        ? () => {
                            setConfirmDelete(false);
                            setConfirmRemoveEmoji(p.emoji);
                            setSheetTarget(item);
                          }
                        : undefined
                    }
                    style={[
                      styles.reactionPill,
                      // Olive tint + outline marks "this contains my reaction
                      // — tap to remove"; others stay on the plain card/white.
                      p.mine
                        ? {
                            backgroundColor: isDark
                              ? 'rgba(75, 94, 42, 0.35)'
                              : 'rgba(75, 94, 42, 0.15)',
                            borderColor: OLIVE,
                          }
                        : {
                            backgroundColor: isDark ? colors.card : '#FFFFFF',
                            borderColor: isDark ? colors.border : '#D0D0D0',
                          },
                    ]}
                  >
                    <View style={styles.emojiStack}>
                      {Array.from({ length: layers }, (_, i) => (
                        <Text
                          key={i}
                          style={[
                            styles.stackEmoji,
                            i > 0 && styles.stackEmojiBehind,
                            { zIndex: layers - i },
                          ]}
                        >
                          {p.emoji}
                        </Text>
                      ))}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          <Text style={[styles.time, { color: colors.icon }]}>{formatTime(item.created_at)}</Text>
        </View>
      );
    },
    [names, colors, isDark, myPlayerId, messages, reactions, toggleReaction]
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Header title="Chat" onMenuPress={openDrawer} />
      {/* KeyboardAvoidingView is a native component that misbehaves on web:
          in a standalone iOS PWA the keyboard-dismiss event doesn't fire
          reliably, so its bottom padding never resets after send and the
          layout stays stale until a touch gesture forces a reflow. Disable
          it on web (the browser's visual viewport already keeps the focused
          input above the keyboard) and keep it for the native app. */}
      <KeyboardAvoidingView
        style={[styles.flex, { paddingBottom: kbInset }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top + 56}
        enabled={Platform.OS !== 'web'}
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
                <Text style={{ color: colors.icon, fontSize: 18 }}>No messages yet. Say hello.</Text>
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

        {pendingImage ? (
          <View style={[styles.pendingWrap, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
            <ExpoImage
              source={{ uri: pendingImage.previewUrl }}
              style={styles.pendingThumb}
              contentFit="cover"
            />
            <Pressable onPress={cancelPendingImage} hitSlop={8} style={styles.pendingCancel}>
              <Text style={styles.pendingCancelText}>✕</Text>
            </Pressable>
          </View>
        ) : null}

        <View
          style={[
            styles.composer,
            {
              borderTopColor: colors.border,
              backgroundColor: colors.card,
              paddingBottom: insets.bottom || 8,
              paddingLeft: 12 + insets.left,
              paddingRight: 12 + insets.right,
            },
          ]}
        >
          {Platform.OS === 'web' ? (
            <Pressable onPress={pickImage} disabled={sending} style={styles.attachBtn} hitSlop={4}>
              <Text style={styles.attachIcon}>📷</Text>
            </Pressable>
          ) : null}
          <View style={styles.inputWrap}>
            <TextInput
              style={[styles.input, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]}
              value={text}
              onChangeText={setText}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              placeholder="Message"
              placeholderTextColor={colors.icon}
              multiline
            />
          </View>
          <Pressable
            onPress={send}
            disabled={sending || (text.trim().length === 0 && !pendingImage)}
            style={[
              styles.send,
              {
                backgroundColor: colors.tint,
                opacity: sending || (text.trim().length === 0 && !pendingImage) ? 0.5 : 1,
              },
            ]}
          >
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      {/* Full-screen image lightbox: tap anywhere to dismiss. */}
      <Modal
        visible={lightboxUrl != null}
        transparent
        animationType="fade"
        onRequestClose={() => setLightboxUrl(null)}
      >
        <Pressable style={styles.lightboxWrap} onPress={() => setLightboxUrl(null)}>
          <ExpoImage
            source={{ uri: lightboxUrl ?? '' }}
            style={styles.lightboxImage}
            contentFit="contain"
            pointerEvents="none"
          />
        </Pressable>
      </Modal>

      {/* Long-press action sheet (custom — works on web and native). */}
      <Modal visible={sheetTarget != null} transparent animationType="slide" onRequestClose={closeSheet}>
        <View style={styles.sheetWrap}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} />
          <View style={[styles.sheet, { backgroundColor: colors.card, paddingBottom: insets.bottom + 12 }]}>
            {confirmDelete ? (
              <>
                <Text style={[styles.sheetTitle, { color: colors.text }]}>Delete this message?</Text>
                <Pressable
                  style={styles.sheetRow}
                  onPress={() => sheetTarget && void deleteMessage(sheetTarget)}
                >
                  <Text style={styles.sheetDestructive}>Delete</Text>
                </Pressable>
                <Pressable style={styles.sheetRow} onPress={closeSheet}>
                  <Text style={[styles.sheetRowText, { color: colors.text }]}>Cancel</Text>
                </Pressable>
              </>
            ) : confirmRemoveEmoji != null ? (
              <>
                <Text style={[styles.sheetTitle, { color: colors.text }]}>
                  Remove your {confirmRemoveEmoji} reaction?
                </Text>
                <Pressable
                  style={styles.sheetRow}
                  onPress={() => {
                    const target = sheetTarget;
                    const emoji = confirmRemoveEmoji;
                    closeSheet();
                    if (target && emoji) void toggleReaction(target.id, emoji, true);
                  }}
                >
                  <Text style={styles.sheetDestructive}>Remove</Text>
                </Pressable>
                <Pressable style={styles.sheetRow} onPress={closeSheet}>
                  <Text style={[styles.sheetRowText, { color: colors.text }]}>Cancel</Text>
                </Pressable>
              </>
            ) : (
              <>
                {sheetTarget ? (
                  <View style={styles.sheetEmojiRow}>
                    {REACTION_EMOJIS.map((e) => {
                      const mine = (reactions.get(sheetTarget.id) ?? []).some(
                        (r) => r.player_id === myPlayerId && r.emoji === e
                      );
                      return (
                        <Pressable
                          key={e}
                          style={[styles.sheetEmojiBtn, mine && styles.sheetEmojiBtnMine]}
                          onPress={() => {
                            void toggleReaction(sheetTarget.id, e, mine);
                            closeSheet();
                          }}
                        >
                          <Text style={styles.sheetEmoji}>{e}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
                {sheetTarget &&
                myPlayerId != null &&
                sheetTarget.author_player_id === myPlayerId ? (
                  <Pressable style={styles.sheetRow} onPress={() => setConfirmDelete(true)}>
                    <Text style={styles.sheetDestructive}>Delete message</Text>
                  </Pressable>
                ) : null}
                <Pressable style={styles.sheetRow} onPress={closeSheet}>
                  <Text style={[styles.sheetRowText, { color: colors.text }]}>Cancel</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 40, transform: [{ scaleY: -1 }] },
  listContent: { paddingHorizontal: 16, paddingVertical: 12 },
  row: { width: '100%' },
  rowMine: { alignItems: 'flex-end' },
  rowOther: { alignItems: 'flex-start' },
  authorLabel: { fontSize: 16, fontWeight: '600', marginBottom: 2, marginLeft: 12 },
  bubble: {
    maxWidth: '78%',
    borderRadius: 18,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  bubbleMine: { backgroundColor: OLIVE },
  // Image fills to the bubble radius; caption re-adds its own padding.
  bubbleWithImage: { paddingVertical: 0, paddingHorizontal: 0, overflow: 'hidden' },
  bubbleText: { fontSize: 25, lineHeight: 33 },
  bubbleTextMine: { color: '#FFFFFF' },
  captionPad: { paddingVertical: 8, paddingHorizontal: 12 },
  time: { fontSize: 13, fontWeight: '400', marginTop: 2, marginHorizontal: 12 },
  olderSpinner: { paddingVertical: 12 },
  error: { textAlign: 'center', paddingVertical: 6, fontSize: 17 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  // Flex-shrink lives on this wrapper View (RNW shrinks views reliably; a bare
  // multiline TextInput renders as a <textarea> whose intrinsic min-width can
  // refuse to shrink and push the Send button off-screen).
  inputWrap: {
    flex: 1,
    minWidth: 0,
  },
  input: {
    width: '100%',
    maxHeight: 150,
    minHeight: 48,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 24,
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 9,
    fontSize: 25, // >=16px: iOS auto-zooms on focusing an input under 16px; that
                  // zoom (not any offset math) is what shoved the composer off-screen.
    lineHeight: 30,
  },
  send: { flexShrink: 0, borderRadius: 24, paddingHorizontal: 18, height: 48, alignItems: 'center', justifyContent: 'center' },
  sendText: { color: '#FFFFFF', fontWeight: '600', fontSize: 20 },

  /* Photo attachment */
  attachBtn: {
    flexShrink: 0,
    width: 44,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachIcon: { fontSize: 29 },
  pendingWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  pendingThumb: { width: 56, height: 56, borderRadius: 8 },
  pendingCancel: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -20,
    marginTop: -40,
  },
  pendingCancelText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  lightboxWrap: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lightboxImage: { width: '100%', height: '100%' },

  /* Long-press action sheet */
  sheetWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 8,
    paddingHorizontal: 16,
  },
  sheetTitle: { fontSize: 20, fontWeight: '600', textAlign: 'center', paddingVertical: 10 },
  sheetRow: { paddingVertical: 14, alignItems: 'center' },
  sheetRowText: { fontSize: 21, fontWeight: '500' },
  sheetDestructive: { fontSize: 21, fontWeight: '600', color: '#D32F2F' },

  /* Reactions */
  reactionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2, maxWidth: '78%' },
  reactionPill: {
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 10,
    paddingVertical: 4,
    // Emoji glyphs can overshoot their line box; never clip at the pill edge.
    overflow: 'visible',
  },
  emojiStack: { flexDirection: 'row', alignItems: 'center' },
  // Fixed 30px slot per 24pt emoji so the overlap step is deterministic
  // regardless of glyph width; lineHeight 30 keeps tall glyphs unclipped.
  stackEmoji: { fontSize: 24, lineHeight: 30, width: 30, textAlign: 'center' },
  // -23 against the 30px slot = each layer peeks 7px out behind the previous.
  stackEmojiBehind: { marginLeft: -23 },
  sheetEmojiRow: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 10 },
  sheetEmojiBtn: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetEmojiBtnMine: { backgroundColor: 'rgba(75, 94, 42, 0.15)' },
  sheetEmoji: { fontSize: 42 },
});
