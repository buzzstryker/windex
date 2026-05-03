import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Header } from '@/components/Header';
import { GroupBanner } from '@/components/GroupBanner';
// GroupSelector removed — group selection now in hamburger drawer
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors } from '@/constants/theme';
import { useDrawer } from '@/contexts/DrawerContext';
import { useGroup } from '@/contexts/GroupContext';
import { useColorScheme } from '@/hooks/use-color-scheme';
import {
  ApiError,
  getStandings,
  type StandingRow,
} from '@/lib/api';

const OLIVE = '#4B5E2A';
const ALL_TIME = '__ALL_TIME__';

function medalForRank(rank: number | undefined): string {
  if (rank === 1) return '\uD83E\uDD47';
  if (rank === 2) return '\uD83E\uDD48';
  if (rank === 3) return '\uD83E\uDD49';
  return '';
}

function fmt(n: number): string {
  return Math.abs(n).toLocaleString('en-US');
}

function formatPoints(points: number, dollarsPerPoint?: number | null): string {
  if (dollarsPerPoint) {
    const dollars = Math.abs(Math.round(points * dollarsPerPoint));
    if (points < 0) return `-$${fmt(dollars)}`;
    return `$${fmt(dollars)}`;
  }
  const rounded = Math.round(points);
  if (rounded < 0) return `-${fmt(rounded)}`;
  return fmt(rounded);
}

export default function StandingsScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? 'light'];
  const muted = colors.icon;
  const { openDrawer } = useDrawer();

  const {
    selectedGroup,
    selectedSeason,
    seasons,
    selectSeason,
    seasonLabel,
    loading: groupLoading,
    reload,
    dataVersion,
  } = useGroup();

  const [standings, setStandings] = useState<StandingRow[]>([]);
  const [loadingStandings, setLoadingStandings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // groupModalVisible removed — group selection in drawer
  const [seasonPickerVisible, setSeasonPickerVisible] = useState(false);
  const [isAllTime, setIsAllTime] = useState(false);

  // Sort seasons newest first
  const sortedSeasons = [...seasons].sort((a, b) =>
    b.start_date.localeCompare(a.start_date),
  );

  const currentDisplayLabel = isAllTime
    ? 'All Time'
    : selectedSeason
      ? seasonLabel(selectedSeason)
      : 'Select Season';

  // Fetch standings — single season or all-time aggregate
  const fetchStandings = useCallback(async () => {
    if (!selectedGroup) return;
    setLoadingStandings(true);
    setError(null);
    try {
      if (isAllTime) {
        // Fetch all seasons and aggregate
        const allRows: StandingRow[] = [];
        for (const s of seasons) {
          const rows = await getStandings(s.id, selectedGroup.id);
          allRows.push(...rows);
        }
        // Merge by player_id: sum total_points and rounds_played
        const merged = new Map<string, StandingRow>();
        for (const row of allRows) {
          const existing = merged.get(row.player_id);
          if (existing) {
            existing.total_points += row.total_points;
            existing.rounds_played += row.rounds_played;
          } else {
            merged.set(row.player_id, { ...row });
          }
        }
        // Sort by total_points descending and assign ranks
        const sorted = [...merged.values()].sort((a, b) => b.total_points - a.total_points);
        sorted.forEach((row, i) => { row.rank = i + 1; });
        setStandings(sorted);
      } else if (selectedSeason) {
        const rows = await getStandings(selectedSeason.id, selectedGroup.id);
        setStandings(rows);
      } else {
        setStandings([]);
      }
    } catch (e) {
      setStandings([]);
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoadingStandings(false);
    }
  }, [selectedGroup?.id, selectedSeason?.id, isAllTime, seasons, dataVersion]);

  useEffect(() => {
    fetchStandings();
  }, [fetchStandings]);

  const refreshData = useCallback(async () => {
    await reload();
    fetchStandings();
  }, [reload, fetchStandings]);

  const handleSeasonSelect = (seasonId: string) => {
    setSeasonPickerVisible(false);
    if (seasonId === ALL_TIME) {
      setIsAllTime(true);
    } else {
      setIsAllTime(false);
      const s = seasons.find((sn) => sn.id === seasonId);
      if (s) selectSeason(s);
    }
  };

  const bannerLabel = isAllTime
    ? 'All Time Standings'
    : selectedSeason
      ? `${seasonLabel(selectedSeason)} Standings`
      : 'Standings';

  const renderRow = ({ item, index }: { item: StandingRow; index: number }) => {
    const medal = medalForRank(item.rank);
    const pts = Math.round(item.total_points);
    const pointsStr = formatPoints(item.total_points, isAllTime ? null : selectedGroup?.dollars_per_point);
    const isTop3 = (item.rank ?? 0) <= 3;
    const isEven = index % 2 === 0;
    const rowBg = isEven
      ? (colorScheme === 'dark' ? '#1C1C1E' : '#FFFFFF')
      : (colorScheme === 'dark' ? '#222224' : '#FAFAFA');

    return (
      <View style={[styles.row, { backgroundColor: rowBg }]}>
        <View style={styles.medalCol}>
          {medal ? (
            <Text style={styles.medalEmoji}>{medal}</Text>
          ) : (
            <View style={styles.medalSpacer} />
          )}
        </View>
        <ThemedText
          style={[styles.nameCol, isTop3 && styles.nameBold]}
          numberOfLines={1}
        >
          {item.player_name ?? item.player_id.slice(0, 8) + '\u2026'}
        </ThemedText>
        <ThemedText style={[styles.roundsCol, { color: muted }]}>
          {item.rounds_played}
        </ThemedText>
        <Text
          style={[
            styles.pointsCol,
            { color: pts >= 0 ? colors.positive : colors.negative },
          ]}
        >
          {pointsStr}
        </Text>
      </View>
    );
  };

  const listHeader = (
    <Pressable
      style={styles.seasonPickerBtn}
      onPress={() => setSeasonPickerVisible(true)}
    >
      <Text style={styles.seasonPickerLabel}>{currentDisplayLabel}</Text>
      <Text style={styles.seasonPickerChevron}>{'\u25BE'}</Text>
    </Pressable>
  );

  return (
    <ThemedView style={styles.screen}>
      <Header title="Standings" onMenuPress={openDrawer} />

      <GroupBanner
        imageUrl={selectedGroup?.logo_url ?? null}
        groupName={selectedGroup?.name ?? ''}
        seasonLabel={bannerLabel}
      />

      {error ? (
        <ThemedText style={styles.errorBanner}>{error}</ThemedText>
      ) : null}

      {groupLoading || loadingStandings ? (
        <ActivityIndicator style={styles.spinner} size="large" />
      ) : (selectedSeason || isAllTime) && standings.length === 0 && !error ? (
        <ThemedText style={[styles.empty, { color: muted }]}>
          No standings data.
        </ThemedText>
      ) : null}

      <FlatList
        data={standings}
        keyExtractor={(item) => item.player_id}
        renderItem={renderRow}
        ListHeaderComponent={listHeader}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        refreshing={loadingStandings}
        onRefresh={refreshData}
      />

      {/* Group selection is in the hamburger drawer */}

      {/* Season picker modal */}
      <Modal visible={seasonPickerVisible} animationType="slide" transparent>
        <View style={styles.modalWrap}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setSeasonPickerVisible(false)} />
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Season</Text>
              <Pressable onPress={() => setSeasonPickerVisible(false)} hitSlop={8}>
                <Text style={styles.modalClose}>{'\u2715'}</Text>
              </Pressable>
            </View>

            {/* All Time option */}
            <Pressable
              style={[styles.seasonRow, isAllTime && styles.seasonRowActive]}
              onPress={() => handleSeasonSelect(ALL_TIME)}
            >
              <Text style={[styles.seasonRowText, isAllTime && styles.seasonRowTextActive]}>
                All Time
              </Text>
              {isAllTime ? <Text style={styles.checkmark}>{'\u2713'}</Text> : null}
            </Pressable>

            <View style={styles.seasonDivider} />

            {/* Individual seasons */}
            <FlatList
              data={sortedSeasons}
              keyExtractor={(s) => s.id}
              renderItem={({ item }) => {
                const isSel = !isAllTime && selectedSeason?.id === item.id;
                return (
                  <Pressable
                    style={[styles.seasonRow, isSel && styles.seasonRowActive]}
                    onPress={() => handleSeasonSelect(item.id)}
                  >
                    <Text style={[styles.seasonRowText, isSel && styles.seasonRowTextActive]}>
                      {seasonLabel(item)}
                    </Text>
                    <Text style={styles.seasonDateRange}>
                      {item.start_date} — {item.end_date}
                    </Text>
                    {isSel ? <Text style={styles.checkmark}>{'\u2713'}</Text> : null}
                  </Pressable>
                );
              }}
            />
          </View>
        </View>
      </Modal>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  headerWrap: { position: 'relative' },
  headerCenter: {
    position: 'absolute', left: 0, right: 0, bottom: 0, top: 0,
    justifyContent: 'center', alignItems: 'center', pointerEvents: 'box-none',
  },
  seasonPickerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: OLIVE,
    gap: 6,
  },
  seasonPickerLabel: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  seasonPickerChevron: {
    color: '#FFFFFF',
    fontSize: 12,
    opacity: 0.8,
  },
  errorBanner: { color: '#c62828', marginBottom: 8, fontSize: 14, paddingHorizontal: 16 },
  spinner: { marginVertical: 24 },
  empty: { textAlign: 'center', marginTop: 24, fontSize: 15 },
  row: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16,
  },
  medalCol: { width: 30, alignItems: 'center', justifyContent: 'center' },
  medalEmoji: { fontSize: 18 },
  medalSpacer: { width: 18 },
  nameCol: { flex: 1, marginRight: 8 },
  nameBold: { fontWeight: '700' },
  roundsCol: { width: 60, textAlign: 'center', fontSize: 14, fontVariant: ['tabular-nums'] },
  pointsCol: { width: 85, textAlign: 'right', fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },

  // Season picker modal
  modalWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: '#FFFFFF', borderTopLeftRadius: 16, borderTopRightRadius: 16,
    paddingHorizontal: 16, paddingTop: 16, maxHeight: '70%',
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12,
  },
  modalTitle: { fontSize: 20, fontWeight: '700', color: '#1A1A1A' },
  modalClose: { fontSize: 20, color: '#8E8E93', padding: 4 },
  seasonRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 8,
    borderRadius: 10, marginBottom: 2,
  },
  seasonRowActive: { backgroundColor: '#F0F4E8' },
  seasonRowText: { fontSize: 16, fontWeight: '600', color: '#1A1A1A', flex: 1 },
  seasonRowTextActive: { color: OLIVE },
  seasonDateRange: { fontSize: 12, color: '#8E8E93', marginRight: 8 },
  checkmark: { fontSize: 18, color: OLIVE, fontWeight: '700' },
  seasonDivider: {
    height: StyleSheet.hairlineWidth, backgroundColor: '#E0E0E0', marginVertical: 4,
  },
});
