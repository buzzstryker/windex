import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { useGroup } from '@/contexts/GroupContext';
import {
  eventTypeLabel,
  formatTimestamp,
  getPlayersWithLastActivity,
  type PlayerWithLastActivity,
} from '@/lib/activity';

const OLIVE = '#4B5E2A';

/**
 * App Activity — list view (super-admin only).
 *
 * Mirrors the windex-admin /activity list page natively. Renders every player
 * with their most-recent activity event (absolute timestamp + summary label).
 * Players with no events sort to the bottom and show "NA". Tapping a row opens
 * the per-player detail timeline.
 *
 * Gated on `useGroup().isSuperAdmin` (the drawer link is gated too); the data
 * is additionally RLS-gated server-side, so a non-super-admin would receive an
 * empty list even if they reached this route directly.
 */
export default function ActivityListScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { isSuperAdmin } = useGroup();

  const [rows, setRows] = useState<PlayerWithLastActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSuperAdmin) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getPlayersWithLastActivity()
      .then((list) => { if (!cancelled) setRows(list); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isSuperAdmin]);

  const renderRow = ({ item }: { item: PlayerWithLastActivity }) => {
    const hasActivity = item.last_event_at !== null;
    return (
      <Pressable
        style={styles.row}
        onPress={() => router.push(`/activity/${encodeURIComponent(item.player_id)}`)}
      >
        <View style={styles.rowLeft}>
          <Text style={styles.rowName} numberOfLines={1}>{item.display_name}</Text>
          <Text style={styles.rowEmail} numberOfLines={1}>{item.email ?? '—'}</Text>
        </View>
        <View style={styles.rowRight}>
          <Text style={[styles.rowEvent, !hasActivity && styles.muted]} numberOfLines={1}>
            {hasActivity ? eventTypeLabel(item.last_event_type) : 'NA'}
          </Text>
          <Text style={[styles.rowTime, !hasActivity && styles.muted]} numberOfLines={1}>
            {hasActivity ? formatTimestamp(item.last_event_at) : 'NA'}
          </Text>
        </View>
      </Pressable>
    );
  };

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <View style={styles.headerRow}>
          <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backButton}>
            <Text style={styles.backArrow}>{'‹'}</Text>
          </Pressable>
          <View style={styles.headerTitleWrap}>
            <Text style={styles.headerTitle} numberOfLines={1}>App Activity</Text>
          </View>
          <View style={styles.backButton} />
        </View>
      </View>

      {!isSuperAdmin ? (
        <View style={styles.card}>
          <Text style={styles.restrictedText}>Restricted to super admins.</Text>
        </View>
      ) : loading ? (
        <ActivityIndicator style={styles.spinner} size="large" color={OLIVE} />
      ) : error ? (
        <View style={styles.errorCard}><Text style={styles.errorText}>{error}</Text></View>
      ) : rows.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>No players in the database.</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.player_id}
          renderItem={renderRow}
          contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
          ListHeaderComponent={
            <Text style={styles.listCaption}>
              Per-player audit of logins, group switches, and tab views.
            </Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F5F5F5' },

  // Back-chevron header — mirrors app/metrics.tsx.
  header: { backgroundColor: OLIVE, width: '100%' },
  headerRow: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  backButton: { width: 32, height: 32, justifyContent: 'center', alignItems: 'center' },
  backArrow: { fontSize: 32, color: '#FFFFFF', fontWeight: '300', lineHeight: 36 },
  headerTitleWrap: { flex: 1, alignItems: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '600', color: '#FFFFFF', textAlign: 'center' },

  spinner: { marginVertical: 40 },
  errorCard: { backgroundColor: '#FFEBEE', borderRadius: 10, padding: 14, margin: 16 },
  errorText: { color: '#C62828', fontSize: 14 },

  card: {
    backgroundColor: '#FFF', borderRadius: 12, marginHorizontal: 12, marginTop: 12,
    padding: 14, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 4, elevation: 2,
  },
  restrictedText: { fontSize: 14, color: '#8E8E93' },
  emptyText: { fontSize: 14, color: '#8E8E93' },

  listCaption: { fontSize: 12, color: '#8E8E93', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5E5',
    backgroundColor: '#FFF',
  },
  rowLeft: { flex: 1, paddingRight: 10 },
  rowName: { fontSize: 15, fontWeight: '600', color: '#1A1A1A' },
  rowEmail: { fontSize: 12, color: '#8E8E93', marginTop: 2 },
  rowRight: { alignItems: 'flex-end', maxWidth: '46%' },
  rowEvent: { fontSize: 13, color: '#1A1A1A', fontWeight: '500' },
  rowTime: { fontSize: 11, color: '#8E8E93', marginTop: 2 },
  muted: { color: '#BBB' },
});
