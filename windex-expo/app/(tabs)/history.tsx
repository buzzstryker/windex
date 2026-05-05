import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import {
  ApiError,
  getPlayerHistory,
  getStandings,
  listGroups,
  listSeasons,
  seasonLabel,
  type Group,
  type PlayerStandingsHistory,
  type Season,
  type StandingRow,
} from '@/lib/api';

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const muted = Colors[colorScheme ?? 'light'].icon;
  const tint = Colors[colorScheme ?? 'light'].tint;
  const border = colorScheme === 'dark' ? '#444' : '#ddd';

  const [groups, setGroups] = useState<Group[]>([]);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [groupId, setGroupId] = useState<string>('');
  const [seasonId, setSeasonId] = useState<string>('');
  const [standings, setStandings] = useState<StandingRow[]>([]);
  const [history, setHistory] = useState<PlayerStandingsHistory | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string>('');

  const [loadingGroups, setLoadingGroups] = useState(true);
  const [loadingSeasons, setLoadingSeasons] = useState(false);
  const [loadingStandings, setLoadingStandings] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<'group' | 'season' | null>(null);

  const selectedGroup = groups.find((g) => g.id === groupId);
  const selectedSeason = seasons.find((s) => s.id === seasonId);
  const selectedPlayer = standings.find((s) => s.player_id === selectedPlayerId);

  const loadGroups = useCallback(async () => {
    setLoadingGroups(true);
    setError(null);
    try {
      const g = await listGroups();
      setGroups(g);
      if (g.length === 1) setGroupId(g[0].id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setGroups([]);
    } finally {
      setLoadingGroups(false);
    }
  }, []);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    if (!groupId) {
      setSeasons([]);
      setSeasonId('');
      return;
    }
    let cancelled = false;
    setLoadingSeasons(true);
    listSeasons(groupId)
      .then((s) => {
        if (!cancelled) {
          setSeasons(s);
          if (s.length === 1) setSeasonId(s[0].id);
          else setSeasonId('');
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : String(e));
          setSeasons([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingSeasons(false);
      });
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  useEffect(() => {
    if (!seasonId) {
      setStandings([]);
      setSelectedPlayerId('');
      setHistory(null);
      return;
    }
    let cancelled = false;
    setLoadingStandings(true);
    setError(null);
    getStandings(seasonId, groupId || undefined)
      .then((rows) => {
        if (!cancelled) {
          setStandings(rows);
          setSelectedPlayerId('');
          setHistory(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setStandings([]);
          setError(e instanceof ApiError ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingStandings(false);
      });
    return () => {
      cancelled = true;
    };
  }, [seasonId, groupId]);

  const handlePlayerTap = useCallback(
    async (playerId: string) => {
      if (!groupId || !seasonId) return;
      setSelectedPlayerId(playerId);
      setLoadingHistory(true);
      setError(null);
      try {
        const data = await getPlayerHistory(groupId, seasonId, playerId);
        setHistory(data);
      } catch (e) {
        setHistory(null);
        setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        setLoadingHistory(false);
      }
    },
    [groupId, seasonId],
  );

  const renderPlayerRow = ({ item }: { item: StandingRow }) => (
    <Pressable
      style={[
        styles.row,
        { borderBottomColor: border },
        item.player_id === selectedPlayerId && { backgroundColor: tint + '18' },
      ]}
      onPress={() => handlePlayerTap(item.player_id)}>
      <ThemedText style={styles.rankCol}>{item.rank ?? '—'}</ThemedText>
      <ThemedText style={styles.nameCol} numberOfLines={1}>
        {item.player_name ?? item.player_id.slice(0, 8) + '...'}
      </ThemedText>
      <ThemedText style={styles.numCol}>{item.rounds_played}</ThemedText>
      <ThemedText style={styles.numCol}>{item.total_points}</ThemedText>
    </Pressable>
  );

  const renderHistoryRow = ({
    item,
  }: {
    item: PlayerStandingsHistory['history'][number];
  }) => (
    <View style={[styles.row, { borderBottomColor: border }]}>
      <ThemedText style={styles.dateCol}>{item.round_date}</ThemedText>
      <ThemedText style={styles.ptsCol}>{Math.round(item.effective_points)}</ThemedText>
    </View>
  );

  return (
    <ThemedView style={[styles.screen, { paddingTop: insets.top + 12 }]}>
      <ThemedText type="title" style={styles.title}>
        History
      </ThemedText>
      <ThemedText style={[styles.sub, { color: muted }]}>
        Select a group, season, then tap a player to see round-by-round history.
      </ThemedText>

      <View style={styles.selectors}>
        <Pressable
          style={[styles.selectBtn, { borderColor: border }]}
          onPress={() => setPicker('group')}
          disabled={loadingGroups}>
          <ThemedText type="defaultSemiBold">Group</ThemedText>
          <ThemedText style={{ color: muted }} numberOfLines={1}>
            {selectedGroup?.name ?? (loadingGroups ? 'Loading...' : 'Choose group')}
          </ThemedText>
        </Pressable>
        <Pressable
          style={[styles.selectBtn, { borderColor: border }]}
          onPress={() => groupId && setPicker('season')}
          disabled={!groupId || loadingSeasons}>
          <ThemedText type="defaultSemiBold">Season</ThemedText>
          <ThemedText style={{ color: muted }} numberOfLines={1}>
            {selectedSeason
              ? seasonLabel(selectedSeason)
              : groupId
                ? loadingSeasons
                  ? 'Loading...'
                  : 'Choose season'
                : 'Select group first'}
          </ThemedText>
        </Pressable>
      </View>

      {error ? (
        <ThemedText style={styles.errorBanner}>{error}</ThemedText>
      ) : null}

      {/* Player list when no player selected yet */}
      {seasonId && !selectedPlayerId && !loadingStandings ? (
        <>
          {standings.length > 0 ? (
            <>
              <ThemedText type="subtitle" style={styles.sectionTitle}>
                Tap a player
              </ThemedText>
              <View style={[styles.tableHeader, { borderBottomColor: border }]}>
                <ThemedText style={[styles.rankCol, { color: muted }]}>#</ThemedText>
                <ThemedText style={[styles.nameCol, { color: muted }]}>Player</ThemedText>
                <ThemedText style={[styles.numCol, { color: muted }]}>Rds</ThemedText>
                <ThemedText style={[styles.numCol, { color: muted }]}>Pts</ThemedText>
              </View>
            </>
          ) : (
            <ThemedText style={[styles.empty, { color: muted }]}>
              No standings for this season yet.
            </ThemedText>
          )}
        </>
      ) : null}

      {loadingStandings ? (
        <ActivityIndicator style={styles.spinner} size="large" />
      ) : null}

      {/* Show standings list when no player is selected */}
      {!selectedPlayerId && standings.length > 0 && !loadingStandings ? (
        <FlatList
          data={standings}
          keyExtractor={(item) => item.player_id}
          renderItem={renderPlayerRow}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        />
      ) : null}

      {/* Show history when a player is selected */}
      {selectedPlayerId ? (
        <>
          <Pressable
            style={[styles.backBtn, { borderColor: border }]}
            onPress={() => {
              setSelectedPlayerId('');
              setHistory(null);
            }}>
            <ThemedText type="defaultSemiBold" style={{ color: tint }}>
              Back to player list
            </ThemedText>
          </Pressable>

          {loadingHistory ? (
            <ActivityIndicator style={styles.spinner} size="large" />
          ) : history ? (
            <>
              <ThemedView style={styles.card}>
                <ThemedText type="subtitle" style={styles.cardTitle}>
                  {history.player_name ?? selectedPlayerId.slice(0, 8)}
                </ThemedText>
                <ThemedText style={{ color: muted }}>
                  Total points: {history.total_points}
                </ThemedText>
                <ThemedText style={{ color: muted }}>
                  Rounds played: {history.rounds_played}
                </ThemedText>
              </ThemedView>

              <View style={[styles.tableHeader, { borderBottomColor: border }]}>
                <ThemedText style={[styles.dateCol, { color: muted }]}>Date</ThemedText>
                <ThemedText style={[styles.ptsCol, { color: muted }]}>Pts</ThemedText>
              </View>

              <FlatList
                data={history.history}
                keyExtractor={(item) => item.event_id}
                renderItem={renderHistoryRow}
                contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
              />
            </>
          ) : null}
        </>
      ) : null}

      <Modal visible={picker !== null} animationType="slide" transparent>
        <View style={styles.modalWrap}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPicker(null)} />
          <ThemedView style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
            <ThemedText type="subtitle" style={styles.modalTitle}>
              {picker === 'group' ? 'Group' : 'Season'}
            </ThemedText>
            <FlatList
              data={picker === 'group' ? groups : seasons}
              keyExtractor={(item: Group | Season) => item.id}
              renderItem={({ item }) => (
                <Pressable
                  style={[styles.modalRow, { borderBottomColor: border }]}
                  onPress={() => {
                    if (picker === 'group') {
                      setGroupId((item as Group).id);
                      setSeasonId('');
                      setSelectedPlayerId('');
                      setHistory(null);
                    } else {
                      setSeasonId((item as Season).id);
                      setSelectedPlayerId('');
                      setHistory(null);
                    }
                    setPicker(null);
                  }}>
                  <ThemedText>
                    {picker === 'group'
                      ? (item as Group).name
                      : seasonLabel(item as Season)}
                  </ThemedText>
                </Pressable>
              )}
            />
            <Pressable style={styles.modalCancel} onPress={() => setPicker(null)}>
              <ThemedText type="defaultSemiBold">Cancel</ThemedText>
            </Pressable>
          </ThemedView>
        </View>
      </Modal>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 16 },
  title: { marginBottom: 4 },
  sub: { fontSize: 14, marginBottom: 16 },
  selectors: { gap: 10, marginBottom: 12 },
  selectBtn: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 4,
  },
  sectionTitle: { marginBottom: 8 },
  errorBanner: { color: '#c62828', marginBottom: 8, fontSize: 14 },
  spinner: { marginVertical: 24 },
  empty: { textAlign: 'center', marginTop: 24, fontSize: 15 },
  backBtn: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignSelf: 'flex-start',
    marginBottom: 12,
  },
  card: {
    borderRadius: 12,
    padding: 18,
    marginBottom: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(128,128,128,0.25)',
  },
  cardTitle: { marginBottom: 4 },
  tableHeader: {
    flexDirection: 'row',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginTop: 8,
  },
  row: {
    flexDirection: 'row',
    paddingVertical: 12,
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rankCol: { width: 36, fontVariant: ['tabular-nums'] },
  nameCol: { flex: 1, marginRight: 8 },
  numCol: { width: 44, textAlign: 'right', fontVariant: ['tabular-nums'] },
  dateCol: { flex: 1 },
  ptsCol: { width: 60, textAlign: 'right', fontVariant: ['tabular-nums'] },
  modalWrap: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
    maxHeight: '70%',
  },
  modalTitle: { marginBottom: 12 },
  modalRow: {
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalCancel: { paddingVertical: 16, alignItems: 'center' },
});
