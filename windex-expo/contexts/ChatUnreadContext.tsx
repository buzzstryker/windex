/**
 * Tracks whether the global chat room has messages newer than the user's
 * room_reads watermark, to drive the unread dot on the Chat tab.
 *
 * Lifecycle mirrors chat.tsx's realtime handling: a persistent channel on the
 * shared supabaseRealtime socket — with a DISTINCT topic
 * ('messages:global:unread', vs the chat screen's 'messages:global') so the
 * two never collide in a duplicate join — torn down on app background and
 * re-subscribed + re-checked on foreground (realtime is not guaranteed
 * delivery across a suspension).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import { getStoredAccessToken } from '@/lib/api';
import { getAuthorPlayerId } from '@/lib/chatAuthor';
import { getApiBase, getSupabaseAnonKey } from '@/lib/config';
import { setRealtimeAuth, supabaseRealtime } from '@/lib/supabase';

const ROOM_ID = 'global';

type ChatUnreadValue = {
  hasUnread: boolean;
  /** Clear the dot (the chat screen calls this when it records the watermark). */
  markRead: () => void;
  /** Chat screen reports focus so live inserts while reading never set the dot. */
  setChatFocused: (focused: boolean) => void;
};

const ChatUnreadContext = createContext<ChatUnreadValue>({
  hasUnread: false,
  markRead: () => {},
  setChatFocused: () => {},
});

export function useChatUnread(): ChatUnreadValue {
  return useContext(ChatUnreadContext);
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

type MessageRow = {
  room_id: string;
  author_player_id: string;
  created_at: string;
  deleted_at: string | null;
};

export function ChatUnreadProvider({ children }: { children: ReactNode }) {
  const [hasUnread, setHasUnread] = useState(false);
  const chatFocusedRef = useRef(false);
  const channelRef = useRef<ReturnType<NonNullable<typeof supabaseRealtime>['channel']> | null>(null);

  const markRead = useCallback(() => setHasUnread(false), []);

  const setChatFocused = useCallback((focused: boolean) => {
    chatFocusedRef.current = focused;
  }, []);

  // One round-trip: latest non-self, non-deleted message vs own watermark.
  // A missing watermark row counts as unread iff any qualifying message exists.
  const checkUnread = useCallback(async () => {
    const headers = await authHeaders();
    if (!headers) return;
    const myId = await getAuthorPlayerId();
    try {
      const notMine = myId ? `&author_player_id=neq.${myId}` : '';
      const [latestRes, readRes] = await Promise.all([
        fetch(
          `${restBase()}/rest/v1/messages?room_id=eq.${ROOM_ID}&deleted_at=is.null${notMine}` +
            `&order=created_at.desc&limit=1&select=created_at`,
          { headers }
        ),
        myId
          ? fetch(
              `${restBase()}/rest/v1/room_reads?room_id=eq.${ROOM_ID}` +
                `&player_id=eq.${myId}&select=last_read_at`,
              { headers }
            )
          : Promise.resolve(null),
      ]);
      if (!latestRes.ok) return;
      const latest: { created_at: string }[] = await latestRes.json();
      if (latest.length === 0) {
        setHasUnread(false);
        return;
      }
      let lastReadAt: string | null = null;
      if (readRes && readRes.ok) {
        const rows: { last_read_at: string }[] = await readRes.json();
        lastReadAt = rows[0]?.last_read_at ?? null;
      }
      // While the user is reading the room, the chat screen owns the watermark.
      if (chatFocusedRef.current) return;
      setHasUnread(!lastReadAt || latest[0].created_at > lastReadAt);
    } catch {
      // Leave state as-is; the next foreground re-checks.
    }
  }, []);

  const onInsert = useCallback((row: MessageRow) => {
    if (!row || row.room_id !== ROOM_ID || row.deleted_at) return;
    if (chatFocusedRef.current) return;
    void (async () => {
      const myId = await getAuthorPlayerId();
      if (myId && row.author_player_id === myId) return;
      setHasUnread(true);
    })();
  }, []);

  const subscribe = useCallback(async () => {
    if (!supabaseRealtime || channelRef.current) return;
    setRealtimeAuth(await getStoredAccessToken()); // fresh token at subscribe time
    channelRef.current = supabaseRealtime
      .channel(`messages:${ROOM_ID}:unread`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${ROOM_ID}` },
        (payload) => onInsert(payload.new as MessageRow)
      )
      .subscribe();
  }, [onInsert]);

  const unsubscribe = useCallback(() => {
    if (supabaseRealtime && channelRef.current) {
      supabaseRealtime.removeChannel(channelRef.current);
    }
    channelRef.current = null;
  }, []);

  useEffect(() => {
    void checkUnread();
    void subscribe();
    const appSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void subscribe();
        void checkUnread();
      } else {
        unsubscribe();
      }
    });
    return () => {
      appSub.remove();
      unsubscribe();
    };
  }, [checkUnread, subscribe, unsubscribe]);

  return (
    <ChatUnreadContext.Provider value={{ hasUnread, markRead, setChatFocused }}>
      {children}
    </ChatUnreadContext.Provider>
  );
}
