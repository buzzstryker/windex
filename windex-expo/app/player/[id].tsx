import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { RoundCard } from '@/components/RoundCard';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import {
  ApiError,
  listEvents,
  type EventSummary,
} from '@/lib/api';
import { fetchRoundScores, type RoundScores } from '@/lib/roundScores';

const OLIVE = '#4B5E2A';

function fmt(n: number): string {
  return Math.abs(n).toLocaleString('en-US');
}

export default function PlayerRoundsScreen() {
  const params = useLocalSearchParams<{
    id: string;
    groupId?: string;
    seasonId?: string;
    seasonName?: string;
    playerName?: string;
    wins?: string;
    losses?: string;
    ties?: string;
    totalPoints?: string;
  }>();
  const playerId = params.id;
  const groupId = params.groupId ?? '';
  const seasonId = params.seasonId ?? '';
  const seasonName = params.seasonName ?? '';
  const playerName = params.playerName ?? 'Player';

  const wins = Number(params.wins ?? '0');
  const losses = Number(params.losses ?? '0');
  const ties = Number(params.ties ?? '0');
  const totalPoints = Number(params.totalPoints ?? '0');

  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? 'light'];
  const muted = colors.icon;
  const router = useRouter();

  const [events, setEvents] = useState<EventSummary[]>([]);
  const [roundScores, setRoundScores] = useState<RoundScores>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!groupId || !seasonId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    listEvents({ group_id: groupId, season_id: seasonId })
      .then(async (ev) => {
        if (cancelled) return;
        ev.sort((a, b) => b.round_date.localeCompare(a.round_date));
        const scores = await fetchRoundScores(ev.map((e) => e.id));
        if (cancelled) return;
        // Keep only rounds where this player has a score row
        const filtered = ev.filter((e) =>
          (scores[e.id] ?? []).some((s) => s.player_id === playerId)
        );
        setEvents(filtered);
        setRoundScores(scores);
      })
      .catch((e) => {
        if (!cancelled) {
          setEvents([]);
          setError(e instanceof ApiError ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [groupId, seasonId, playerId]);

  const headerTitle = seasonName ? `${playerName} — ${seasonName}` : playerName;

  const netLabel = useMemo(() => {
    const rounded = Math.round(totalPoints);
    if (rounded < 0) return `-${fmt(rounded)}`;
    if (rounded > 0) return `+${fmt(rounded)}`;
    return '0';
  }, [totalPoints]);

  const netColor = totalPoints >= 0 ? colors.positive : colors.negative;

  const renderRound = ({ item }: { item: EventSummary }) => (
    <RoundCard
      event={item}
      scores={roundScores[item.id] ?? []}
      onPress={() => router.push(`/round/${item.id}`)}
    />
  );

  const summaryStrip = (
    <View style={styles.summaryRow}>
      <View style={styles.summaryBlock}>
        <Text style={[styles.summaryLabel, { color: muted }]}>W/L/T</Text>
        <View style={styles.wltRow}>
          <Text style={[styles.wltNum, { color: colors.positive }]}>{wins}</Text>
          <Text style={[styles.wltSep, { color: colors.text }]}> / </Text>
          <Text style={[styles.wltNum, { color: colors.negative }]}>{losses}</Text>
          <Text style={[styles.wltSep, { color: colors.text }]}> / </Text>
          <Text style={[styles.wltNum, { color: colors.text }]}>{ties}</Text>
        </View>
      </View>
      <View style={styles.summaryBlock}>
        <Text style={[styles.summaryLabel, { color: muted }]}>+/-</Text>
        <Text style={[styles.netNum, { color: netColor }]}>{netLabel}</Text>
      </View>
    </View>
  );

  return (
    <ThemedView style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <View style={styles.headerRow}>
          <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backButton}>
            <Text style={styles.backArrow}>{'‹'}</Text>
          </Pressable>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {headerTitle}
          </Text>
          <View style={styles.backButton} />
        </View>
      </View>

      {error ? (
        <ThemedText style={styles.errorBanner}>{error}</ThemedText>
      ) : null}

      {loading ? (
        <ActivityIndicator style={styles.spinner} size="large" />
      ) : events.length === 0 && !error ? (
        <>
          {summaryStrip}
          <ThemedText style={[styles.empty, { color: muted }]}>
            No rounds found for this player in this season.
          </ThemedText>
        </>
      ) : (
        <FlatList
          data={events}
          keyExtractor={(item) => item.id}
          renderItem={renderRound}
          ListHeaderComponent={summaryStrip}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 24 }]}
        />
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    backgroundColor: OLIVE,
    width: '100%',
  },
  headerRow: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  backButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backArrow: {
    fontSize: 32,
    color: '#FFFFFF',
    fontWeight: '300',
    lineHeight: 36,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#FFFFFF',
    textAlign: 'center',
    flex: 1,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  summaryBlock: { alignItems: 'flex-start' },
  summaryLabel: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  wltRow: { flexDirection: 'row', alignItems: 'center' },
  wltNum: { fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  wltSep: { fontSize: 18, fontVariant: ['tabular-nums'] },
  netNum: { fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  errorBanner: { color: '#c62828', marginBottom: 8, fontSize: 14, paddingHorizontal: 16 },
  spinner: { marginVertical: 24 },
  empty: { textAlign: 'center', marginTop: 24, fontSize: 15 },
  listContent: { paddingHorizontal: 16 },
});
