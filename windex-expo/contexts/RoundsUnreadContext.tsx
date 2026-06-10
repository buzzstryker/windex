/**
 * Tracks whether any rounds were entered (league_rounds.created_at) in groups
 * the user belongs to since they last viewed the Rounds tab (rounds_reads
 * watermark). Drives the Rounds tab dot and contributes to the PWA icon badge.
 *
 * Sibling to ChatUnreadProvider, deliberately NOT merged: this is a pure
 * polling signal (league_rounds is not in the realtime publication) — checked
 * on mount, on app foreground, and when the membership set changes.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import { useGroup } from '@/contexts/GroupContext';
import { getStoredAccessToken } from '@/lib/api';
import { getAuthorPlayerId } from '@/lib/chatAuthor';
import { getApiBase, getSupabaseAnonKey } from '@/lib/config';

type RoundsUnreadValue = {
  hasUnreadRounds: boolean;
  /** Clear the dot (the Rounds tab calls this when it records the watermark). */
  markRoundsSeen: () => void;
};

const RoundsUnreadContext = createContext<RoundsUnreadValue>({
  hasUnreadRounds: false,
  markRoundsSeen: () => {},
});

export function useRoundsUnread(): RoundsUnreadValue {
  return useContext(RoundsUnreadContext);
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

export function RoundsUnreadProvider({ children }: { children: ReactNode }) {
  const [hasUnreadRounds, setHasUnreadRounds] = useState(false);
  const { myGroups } = useGroup();

  // Stable key so checkUnread (and the effect below) re-run only when the
  // membership set truly changes, not on every GroupContext render.
  const myGroupIdsKey = useMemo(
    () => myGroups.map((g) => g.id).sort().join(','),
    [myGroups]
  );

  const markRoundsSeen = useCallback(() => setHasUnreadRounds(false), []);

  // Watermark (missing row = epoch) vs any round entered since in my groups.
  const checkUnread = useCallback(async () => {
    if (!myGroupIdsKey) return;
    const headers = await authHeaders();
    if (!headers) return;
    const myId = await getAuthorPlayerId();
    if (!myId) return;
    try {
      const readRes = await fetch(
        `${restBase()}/rest/v1/rounds_reads?player_id=eq.${myId}&select=last_seen_at`,
        { headers }
      );
      let lastSeenAt = '1970-01-01T00:00:00Z';
      if (readRes.ok) {
        const rows: { last_seen_at: string }[] = await readRes.json();
        if (rows[0]?.last_seen_at) lastSeenAt = rows[0].last_seen_at;
      }
      const roundsRes = await fetch(
        `${restBase()}/rest/v1/league_rounds?group_id=in.(${myGroupIdsKey})` +
          `&row_type=eq.regular_round&created_at=gt.${encodeURIComponent(lastSeenAt)}` +
          `&select=id&limit=1`,
        { headers }
      );
      if (!roundsRes.ok) return;
      const hits: { id: string }[] = await roundsRes.json();
      setHasUnreadRounds(hits.length > 0);
    } catch {
      // Leave state as-is; the next foreground re-checks.
    }
  }, [myGroupIdsKey]);

  useEffect(() => {
    void checkUnread();
    const appSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void checkUnread();
    });
    return () => appSub.remove();
  }, [checkUnread]);

  return (
    <RoundsUnreadContext.Provider value={{ hasUnreadRounds, markRoundsSeen }}>
      {children}
    </RoundsUnreadContext.Provider>
  );
}
