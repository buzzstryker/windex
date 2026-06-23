import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { useGroup } from '@/contexts/GroupContext';
import { useSafeBack } from '@/lib/useSafeBack';
import {
  eventTypeLabel,
  formatTimestamp,
  getPlayerActivitySummary,
  getPlayerActivityTimeline,
  getPlayersWithLastActivity,
  relativeTime,
  seasonYearLabel,
  type ActivityTimelineRow,
  type PlayerActivitySummary,
} from '@/lib/activity';

const OLIVE = '#4B5E2A';
const PAGE_LIMIT = 100;

/**
 * App Activity — per-player detail (super-admin only).
 *
 * Summary block (total events, first/last seen, per-type breakdown) plus a
 * reverse-chronological timeline. v1 fetches the latest 100 events with no
 * Load-more; a "Showing latest 100" note appears when exactly 100 return.
 *
 * Gated on `useGroup().isSuperAdmin` and RLS-gated server-side.
 */
export default function ActivityDetailScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const goBack = useSafeBack();
  const { isSuperAdmin } = useGroup();
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = rawId ?? '';

  const [summary, setSummary] = useState<PlayerActivitySummary | null>(null);
  const [timeline, setTimeline] = useState<ActivityTimelineRow[]>([]);
  const [playerName, setPlayerName] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSuperAdmin || !id) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      getPlayerActivitySummary(id),
      getPlayerActivityTimeline(id, PAGE_LIMIT),
    ])
      .then(([sum, tl]) => {
        if (cancelled) return;
        setSummary(sum);
        setTimeline(tl);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isSuperAdmin, id]);

  // Best-effort player name for the header — derived from the same list RPC the
  // list page uses (the timeline rows don't carry display_name). Degrades to
  // the header fallback if it fails.
  useEffect(() => {
    if (!isSuperAdmin || !id) return;
    let cancelled = false;
    getPlayersWithLastActivity()
      .then((list) => {
        if (cancelled) return;
        const me = list.find((r) => r.player_id === id);
        if (me) setPlayerName(me.display_name);
      })
      .catch(() => {/* silent — header degrades to fallback */});
    return () => { cancelled = true; };
  }, [isSuperAdmin, id]);

  const headerTitle = playerName || 'Player Activity';
  const showLatestNote = timeline.length === PAGE_LIMIT;

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <View style={styles.headerRow}>
          <Pressable onPress={goBack} hitSlop={8} style={styles.backButton}>
            <Text style={styles.backArrow}>{'‹'}</Text>
          </Pressable>
          <View style={styles.headerTitleWrap}>
            <Text style={styles.headerTitle} numberOfLines={1}>{headerTitle}</Text>
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
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Summary */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Summary</Text>
            {summary && summary.total_events > 0 ? (
              <>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Total events</Text>
                  <Text style={styles.summaryValue}>{summary.total_events.toLocaleString('en-US')}</Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>First seen</Text>
                  <Text style={styles.summaryValue}>{formatTimestamp(summary.first_event_at)}</Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Last seen</Text>
                  <Text style={styles.summaryValue}>
                    {formatTimestamp(summary.last_event_at)}
                    {summary.last_event_at ? (
                      <Text style={styles.summaryRel}> ({relativeTime(summary.last_event_at)})</Text>
                    ) : null}
                  </Text>
                </View>
                <View style={styles.breakdown}>
                  <Text style={styles.breakdownTitle}>Breakdown</Text>
                  {Object.entries(summary.event_type_counts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([type, count]) => (
                      <View key={type} style={styles.breakdownRow}>
                        <Text style={styles.breakdownLabel}>{eventTypeLabel(type)}</Text>
                        <Text style={styles.breakdownCount}>{count}</Text>
                      </View>
                    ))}
                </View>
              </>
            ) : (
              <Text style={styles.emptyText}>No activity recorded for this player yet.</Text>
            )}
          </View>

          {/* Timeline */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Timeline</Text>
            {timeline.length === 0 ? (
              <Text style={styles.emptyText}>No activity recorded for this player yet.</Text>
            ) : (
              <>
                {timeline.map((row) => {
                  const ctx = contextLabel(row);
                  return (
                    <View key={row.id} style={styles.tlRow}>
                      <View style={styles.tlLeft}>
                        <Text style={styles.tlEvent}>{eventTypeLabel(row.event_type)}</Text>
                        {ctx ? <Text style={styles.tlContext} numberOfLines={1}>{ctx}</Text> : null}
                      </View>
                      <Text style={styles.tlTime} numberOfLines={1}>{formatTimestamp(row.occurred_at)}</Text>
                    </View>
                  );
                })}
                {showLatestNote && (
                  <Text style={styles.latestNote}>Showing latest 100</Text>
                )}
              </>
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

/**
 * Per-event-type context line. group_switch shows "from → to"; view_* shows
 * "<Group> / <year>"; login/logout have no context.
 */
function contextLabel(row: ActivityTimelineRow): string {
  if (row.event_type === 'group_switch') {
    const from = row.from_group_name ?? row.from_group_id ?? '?';
    const to = row.group_name ?? row.group_id ?? '?';
    return `${from} → ${to}`;
  }
  if (row.event_type === 'view_leaderboard' || row.event_type === 'view_rounds_list') {
    const group = row.group_name ?? row.group_id ?? '';
    const season = seasonYearLabel(row.season_start_date, row.season_end_date);
    if (group && season) return `${group} / ${season}`;
    return group || season || '';
  }
  return '';
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
  cardTitle: { fontSize: 17, fontWeight: '700', color: '#1A1A1A', marginBottom: 8 },
  restrictedText: { fontSize: 14, color: '#8E8E93' },
  emptyText: { fontSize: 14, color: '#8E8E93' },

  // Summary
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  summaryLabel: { fontSize: 13, color: '#8E8E93' },
  summaryValue: { fontSize: 13, color: '#1A1A1A', fontWeight: '500', flexShrink: 1, textAlign: 'right', marginLeft: 12 },
  summaryRel: { color: '#999', fontWeight: '400' },
  breakdown: { marginTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#EEE', paddingTop: 8 },
  breakdownTitle: { fontSize: 11, fontWeight: '700', color: '#8E8E93', textTransform: 'uppercase', marginBottom: 4 },
  breakdownRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  breakdownLabel: { fontSize: 13, color: '#1A1A1A' },
  breakdownCount: { fontSize: 13, color: '#1A1A1A', fontWeight: '600' },

  // Timeline
  tlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#EEE',
  },
  tlLeft: { flex: 1, paddingRight: 10 },
  tlEvent: { fontSize: 14, color: '#1A1A1A', fontWeight: '500' },
  tlContext: { fontSize: 12, color: '#666', marginTop: 2 },
  tlTime: { fontSize: 11, color: '#8E8E93', maxWidth: '42%', textAlign: 'right' },
  latestNote: { fontSize: 12, color: '#999', textAlign: 'center', marginTop: 12 },
});
