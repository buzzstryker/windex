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
  getChampionshipResults,
  listEvents,
  ordinalPlace,
  seasonLabel,
  tiedPlaces,
  type ChampionshipResult,
  type EventSummary,
  type Season,
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
  // Group-scoped (not player-scoped) so tie detection sees every row in
  // each season, not just this player's.
  const [groupChamps, setGroupChamps] = useState<ChampionshipResult[]>([]);

  useEffect(() => {
    if (!groupId) return;
    let cancelled = false;
    getChampionshipResults({ group_id: groupId })
      .then((rows) => {
        if (!cancelled) setGroupChamps(rows);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [groupId]);

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

  // This player's placements, newest season first, with per-season tie flags.
  const myPlacements = useMemo(() => {
    const bySeason = new Map<string, ChampionshipResult[]>();
    for (const r of groupChamps) {
      const list = bySeason.get(r.season_id);
      if (list) list.push(r);
      else bySeason.set(r.season_id, [r]);
    }
    return groupChamps
      .filter((r) => r.player_id === playerId)
      .map((r) => ({
        row: r,
        tied: r.place !== null && tiedPlaces(bySeason.get(r.season_id) ?? []).has(r.place),
        label: seasonLabel({
          id: r.season_id,
          start_date: r.seasons?.start_date,
          end_date: r.seasons?.end_date,
        } as Season),
      }))
      .sort((a, b) =>
        (b.row.seasons?.start_date ?? '').localeCompare(a.row.seasons?.start_date ?? '')
      );
  }, [groupChamps, playerId]);

  const championshipsCard =
    myPlacements.length > 0 ? (
      <View style={[styles.champCard, { borderColor: colors.border, backgroundColor: colors.card }]}>
        <Text style={[styles.champTitle, { color: muted }]}>CUP CHAMPIONSHIPS</Text>
        {myPlacements.map((p) => (
          <View key={p.row.season_id} style={styles.champRow}>
            <Text style={[styles.champSeason, { color: colors.text }]}>{p.label}</Text>
            <Text
              style={[
                styles.champPlace,
                { color: p.row.place === 1 ? OLIVE : colors.text },
              ]}
            >
              {p.row.place === 1 ? '🏆 ' : ''}
              {p.row.place !== null ? ordinalPlace(p.row.place, p.tied) : 'Last'}
              {/* Plain emoji for now; the teal FJ Socks SVG is the upgrade path. */}
              {p.row.is_last_place ? ' 🧦' : ''}
            </Text>
          </View>
        ))}
      </View>
    ) : null;

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
          {championshipsCard}
          <ThemedText style={[styles.empty, { color: muted }]}>
            No rounds found for this player in this season.
          </ThemedText>
        </>
      ) : (
        <FlatList
          data={events}
          keyExtractor={(item) => item.id}
          renderItem={renderRound}
          ListHeaderComponent={
            <>
              {summaryStrip}
              {championshipsCard}
            </>
          }
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

  /* Cup Championships card — label style mirrors summaryLabel. */
  champCard: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  champTitle: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  champRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  champSeason: { fontSize: 15, fontWeight: '500' },
  champPlace: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
