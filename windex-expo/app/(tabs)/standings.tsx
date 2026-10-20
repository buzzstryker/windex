import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';

import { Header } from '@/components/Header';
import { GroupBanner } from '@/components/GroupBanner';
import { GroupPicker } from '@/components/GroupPicker';
import { HistoryChart } from '@/components/HistoryChart';
import { SegmentedToggle } from '@/components/SegmentedToggle';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { UpdatedAgo } from '@/components/UpdatedAgo';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import { useDrawer } from '@/contexts/DrawerContext';
import { useGroup } from '@/contexts/GroupContext';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { ApiError, type StandingRow } from '@/lib/api';
import {
  ALL_TIME_STALE_MS,
  fetchAllTime,
  fetchSeasonStandings,
  leaderboardKeys,
  seasonQueryOptions,
} from '@/lib/leaderboardData';
import { SESSION_START_MS } from '@/lib/queryClient';
import { logUserEvent } from '@/lib/userEvents';

const EMPTY_ROWS: StandingRow[] = [];

const OLIVE = '#4B5E2A';
const ALL_TIME = '__ALL_TIME__';

function fmt(n: number): string {
  return Math.abs(n).toLocaleString('en-US');
}

/**
 * Render players.full_name as "F. Lastname". Middle names/initials are
 * discarded. Single-token names render as-is. Null/blank → empty string.
 *
 *   "John Miller"        -> "J. Miller"
 *   "Mary Jane Smith"    -> "M. Smith"
 *   "Mary Smith-Jones"   -> "M. Smith-Jones"
 *   "Cher"               -> "Cher"
 *   "" / null / "   "    -> ""
 *   "John Miller Jr."    -> "J. Jr."  (acceptable edge case)
 */
function formatInitialLastName(fullName?: string | null): string {
  if (!fullName) return '';
  const trimmed = fullName.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  const tokens = trimmed.split(' ');
  if (tokens.length === 1) return tokens[0];
  return `${tokens[0].charAt(0).toUpperCase()}. ${tokens[tokens.length - 1]}`;
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
  const router = useRouter();
  const { openDrawer } = useDrawer();

  const { userId } = useAuth();
  const {
    selectedGroup,
    selectedSeason,
    seasons,
    selectSeason,
    seasonLabel,
    loading: groupLoading,
    reload,
    myPlayerIds,
    isSelectedSeasonActive,
    isSelectedSeasonClosed,
    defaultSeasonId,
  } = useGroup();

  // Log view_leaderboard on initial mount and whenever the selected group
  // or season changes. Read myPlayerIds via a ref so the effect doesn't
  // re-fire when the player_id cache resolves a beat after sign-in.
  const myPlayerIdsRef = useRef(myPlayerIds);
  myPlayerIdsRef.current = myPlayerIds;
  useEffect(() => {
    if (selectedGroup && selectedSeason) {
      void logUserEvent('view_leaderboard', {
        groupId: selectedGroup.id,
        seasonId: selectedSeason.id,
        playerId: myPlayerIdsRef.current[0] ?? null,
      });
    }
  }, [selectedGroup?.id, selectedSeason?.id]);

  const [seasonPickerVisible, setSeasonPickerVisible] = useState(false);
  const [isAllTime, setIsAllTime] = useState(false);
  const [tab, setTab] = useState<'leaderboard' | 'history'>('leaderboard');
  const [pulling, setPulling] = useState(false);

  // One season's standings + match count, from the device cache first, then
  // get_season_standings (migration 061). The bootstrap seeds the default
  // season's entry, so app open makes no request here. A closed season is a
  // frozen snapshot: never stale, never refetched.
  const groupId = selectedGroup?.id ?? null;
  const seasonId = selectedSeason?.id ?? null;
  const seasonQuery = useQuery({
    queryKey: leaderboardKeys.season(userId ?? '', groupId ?? '', seasonId ?? ''),
    queryFn: () => fetchSeasonStandings(groupId!, seasonId!),
    enabled: !!userId && !!groupId && !!seasonId && !isAllTime,
    ...seasonQueryOptions(isSelectedSeasonClosed),
  });

  // All Time: one get_all_time_standings call (snapshots for closed seasons,
  // live for open ones) instead of one get-standings per season.
  const allTimeQuery = useQuery({
    queryKey: leaderboardKeys.allTime(userId ?? '', groupId ?? ''),
    queryFn: () => fetchAllTime(groupId!, seasons),
    enabled: !!userId && !!groupId && isAllTime,
    staleTime: ALL_TIME_STALE_MS,
  });

  const activeQuery = isAllTime ? allTimeQuery : seasonQuery;
  const standings = activeQuery.data?.standings ?? EMPTY_ROWS;
  // Spinner only when there is nothing cached to show.
  const loadingStandings = !activeQuery.data && activeQuery.isFetching;
  const queryError = activeQuery.error;
  const error = queryError && !activeQuery.data
    ? (queryError instanceof ApiError ? queryError.message : String(queryError))
    : null;

  // Matches-played count for the season-selector pill: match_count from the
  // same payload (the events-list row count for the season, which is what the
  // Rounds tab lists). null = N/A (All Time / not loaded): the pill shows the
  // bare season label, never ": 0 Matches".
  const seasonRoundCount = !isAllTime ? seasonQuery.data?.match_count ?? null : null;

  // "Updated X ago": the current season's rows came from the device cache and
  // no fetch has succeeded since this session started (an offline reopen, or
  // the moment before the background revalidation lands).
  const showUpdatedAgo =
    !isAllTime &&
    isSelectedSeasonActive &&
    !isSelectedSeasonClosed &&
    !!seasonQuery.data &&
    seasonQuery.dataUpdatedAt < SESSION_START_MS;

  // Sort seasons newest first
  const sortedSeasons = [...seasons].sort((a, b) =>
    b.start_date.localeCompare(a.start_date),
  );

  const currentDisplayLabel = isAllTime
    ? 'All Time'
    : selectedSeason
      ? seasonLabel(selectedSeason)
      : 'Select Season';

  // Pill label with rounds-played suffix. Only the active/displayed pill gets
  // the suffix (not the picker options). Drop the suffix while the count is
  // loading (null) or zero (legacy aggregate-only seasons) so we show the bare
  // season label instead of ": 0 Rounds". Singular vs plural on N === 1.
  const seasonPillLabel =
    seasonRoundCount && seasonRoundCount > 0
      ? `${currentDisplayLabel}: ${seasonRoundCount} ${seasonRoundCount === 1 ? 'Match' : 'Matches'}`
      : currentDisplayLabel;

  // Tab focus: refetch only what is past its staleTime (30 s for an open
  // season, 5 min for All Time; a closed season never). Previously every focus
  // refetched.
  const { isStale, refetch } = activeQuery;
  useFocusEffect(
    useCallback(() => {
      if (activeQuery.data && isStale) void refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isStale, refetch])
  );

  // Pull-to-refresh: forced bootstrap refetch (which reseeds the default
  // season), plus the shown season or All Time when the bootstrap doesn't
  // carry it.
  const refreshData = useCallback(async () => {
    setPulling(true);
    try {
      const extra = isAllTime
        ? allTimeQuery.refetch()
        : seasonId && seasonId !== defaultSeasonId
          ? seasonQuery.refetch()
          : Promise.resolve();
      await Promise.all([reload(), extra]);
    } finally {
      setPulling(false);
    }
  }, [isAllTime, allTimeQuery, seasonQuery, seasonId, defaultSeasonId, reload]);

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

  // Cup Champion indicator. Show a trophy on the champion's standings row, but
  // ONLY for a completed past season (end_date < today, i.e. not active) that
  // has a recorded champion. Active/current season, All Time, and seasons with
  // no recorded champion render no icon. Display-only — does NOT affect the
  // points-descending sort or row position. Source is seasons.cup_champion_player_id
  // (migration 025), already on the Season object via listSeasons — the same
  // source the GroupDetail "Previous Seasons" card uses. Matched to a standings
  // row by player_id; if no row matches (e.g. champion played zero rounds or is
  // no longer an active member, so season_standings omits them), no icon renders.
  const seasonCompleted = !isAllTime && !!selectedSeason && !isSelectedSeasonActive;
  const championPlayerId = seasonCompleted ? (selectedSeason?.cup_champion_player_id ?? null) : null;

  const renderRow = ({ item, index }: { item: StandingRow; index: number }) => {
    const pts = Math.round(item.total_points);
    const pointsStr = formatPoints(item.total_points, isAllTime ? null : selectedGroup?.dollars_per_point);
    const isEven = index % 2 === 0;
    const rowBg = isEven
      ? (colorScheme === 'dark' ? '#1C1C1E' : '#FFFFFF')
      : (colorScheme === 'dark' ? '#222224' : '#FAFAFA');

    const isChampion = !!championPlayerId && item.player_id === championPlayerId;
    const canOpenPlayer = !isAllTime && !!selectedSeason && !!selectedGroup;
    const handlePress = () => {
      if (!canOpenPlayer) return;
      const qs = new URLSearchParams({
        groupId: selectedGroup!.id,
        seasonId: selectedSeason!.id,
        seasonName: seasonLabel(selectedSeason!),
        playerName: item.player_name ?? '',
        wins: String(item.wins),
        losses: String(item.losses),
        ties: String(item.ties),
        totalPoints: String(item.total_points),
      }).toString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      router.push(`/player/${item.player_id}?${qs}` as any);
    };

    return (
      <Pressable
        onPress={handlePress}
        disabled={!canOpenPlayer}
        style={[styles.row, { backgroundColor: rowBg }]}
      >
        <Text style={[styles.rankCol, { color: muted }]}>
          {item.rank ?? index + 1}
        </Text>
        <ThemedText
          style={styles.nameCol}
          numberOfLines={1}
        >
          {item.player_name ?? item.player_id.slice(0, 8) + '\u2026'}
        </ThemedText>
        <ThemedText
          style={styles.fullNameCol}
          numberOfLines={1}
          ellipsizeMode="tail"
          accessibilityLabel={
            isChampion
              ? `${formatInitialLastName(item.full_name)}, Cup Champion`
              : undefined
          }
        >
          {isChampion ? '🏆 ' : ''}{formatInitialLastName(item.full_name)}
        </ThemedText>
        <View style={styles.wltCol}>
          <Text style={[styles.wltNum, { color: colors.positive }]}>{item.wins}</Text>
          <Text style={[styles.wltSep, { color: colors.text }]}> / </Text>
          <Text style={[styles.wltNum, { color: colors.negative }]}>{item.losses}</Text>
          <Text style={[styles.wltSep, { color: colors.text }]}> / </Text>
          <Text style={[styles.wltNum, { color: colors.text }]}>{item.ties}</Text>
        </View>
        <Text
          style={[
            styles.pointsCol,
            { color: pts >= 0 ? colors.positive : colors.negative },
          ]}
        >
          {pointsStr}
        </Text>
      </Pressable>
    );
  };

  // History tab disabled for All Time (needs a single season)
  const historyAvailable = !isAllTime && !!selectedSeason;

  const controlBar = (
    <View style={styles.controlRow}>
      {/* Season picker */}
      <Pressable
        style={styles.seasonPickerBtn}
        onPress={() => setSeasonPickerVisible(true)}
      >
        <Text style={styles.seasonPickerLabel}>{seasonPillLabel}</Text>
        <Text style={styles.seasonPickerChevron}>{'\u25BE'}</Text>
      </Pressable>

      {/* Leaderboard / History toggle */}
      <SegmentedToggle
        options={[
          { key: 'leaderboard', label: 'Leaderboard' },
          { key: 'history', label: 'History', disabled: !historyAvailable },
        ]}
        value={tab}
        onChange={setTab}
      />
    </View>
  );

  const leaderboardHeader = (
    <>
      {controlBar}
      {showUpdatedAgo ? <UpdatedAgo updatedAt={seasonQuery.dataUpdatedAt} color={muted} /> : null}
    </>
  );

  return (
    <ThemedView style={styles.screen}>
      <Header title={<GroupPicker tabName="Standings" />} onMenuPress={openDrawer} />

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
      ) : !selectedGroup && !error ? (
        // Defensive: no selectable league resolved. Unreachable for any current
        // signed-in user (every one holds a league membership), but a roster-
        // only future user would land here rather than on a blank screen.
        // context `loading` stays true until selectedGroup resolves or groups
        // is empty, so this never flashes during a normal load.
        <ThemedText style={[styles.empty, { color: muted }]}>
          You’re not in an active league yet.{'\n'}Ask an admin to add you to a group.
        </ThemedText>
      ) : (selectedSeason || isAllTime) && standings.length === 0 && !error ? (
        <ThemedText style={[styles.empty, { color: muted }]}>
          No standings data.
        </ThemedText>
      ) : null}

      {tab === 'leaderboard' ? (
        <FlatList
          data={standings}
          keyExtractor={(item) => item.player_id}
          renderItem={renderRow}
          ListHeaderComponent={leaderboardHeader}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          refreshing={pulling}
          onRefresh={refreshData}
        />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          refreshControl={undefined}
        >
          {controlBar}
          {selectedSeason && selectedGroup && standings.length > 0 ? (
            <HistoryChart
              seasonId={selectedSeason.id}
              groupId={selectedGroup.id}
              standings={standings}
              seasonStartDate={selectedSeason.start_date}
              seasonEndDate={selectedSeason.end_date}
              seasons={seasons}
            />
          ) : null}
        </ScrollView>
      )}

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
  controlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    marginBottom: 12,
    gap: 10,
  },
  seasonPickerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
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
  rankCol: { width: 30, textAlign: 'center', fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] as const },
  // Display-name col: FIXED width so the full_name column to its right
  // starts at the same x on every row (not floating with each name's
  // length). 75px fits the current longest display_names (ATrain, Dagger,
  // Diesel, Smooth — all 6 chars) with proportional headroom at default
  // body font. flexShrink: 0 so it never gets crushed; the full-name
  // column to the right absorbs any overflow.
  nameCol: { width: 75, flexShrink: 0, marginRight: 8 },
  // Full-name col is the flexible cell: takes remaining row width and
  // truncates with ellipsis (ellipsizeMode="tail" on the Text) when names
  // are long. flex: 1 implies flexShrink: 1 by default.
  fullNameCol: { flex: 1, marginRight: 8 },
  // Tightened from width:95 — typical content "82 / 5 / 0" is ~55-60px;
  // 80 still covers two-digit/early three-digit values without truncation
  // and stops wasting ~15px of internal centering padding.
  wltCol: { width: 80, flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  wltNum: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  wltSep: { fontSize: 14, fontVariant: ['tabular-nums'] },
  // Tightened from width:85 — textAlign:right means any extra width
  // accumulates as left-side gap before the number. 70 fits "-$9,999" worst
  // case and reclaims ~15px for the flexible full_name column.
  pointsCol: { width: 70, textAlign: 'right', fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },

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
