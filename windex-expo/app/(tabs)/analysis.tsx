import { useCallback, useEffect, useState } from 'react';
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

import { Header } from '@/components/Header';
import { GroupBanner } from '@/components/GroupBanner';
import { Colors } from '@/constants/theme';
import { useDrawer } from '@/contexts/DrawerContext';
import { useGroup } from '@/contexts/GroupContext';
import { useColorScheme } from '@/hooks/use-color-scheme';
import {
  getPointsAnalysis,
  getPointsMatrix,
  getStoredAccessToken,
  type PointsAnalysisResponse,
} from '@/lib/api';
import { getApiBase, getSupabaseAnonKey } from '@/lib/config';

const OLIVE = '#4B5E2A';

/* ── Matrix types ── */

type MatrixCell = { net: number; rounds: number };
type MatrixData = {
  playerIds: string[];
  playerNames: Record<string, string>;
  cells: Record<string, Record<string, MatrixCell>>;
};

/* ── Component ── */

export default function AnalysisScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? 'light'];
  const { openDrawer } = useDrawer();
  const { selectedGroup } = useGroup();
  const groupId = selectedGroup?.id ?? '';

  // showGroupSelector removed — group selection in drawer
  const [matrix, setMatrix] = useState<MatrixData | null>(null);
  const [loadingMatrix, setLoadingMatrix] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [excludeSig, setExcludeSig] = useState(true);

  // Matchup filter
  const [matchupPlayer, setMatchupPlayer] = useState('');
  const [matchupPickerVisible, setMatchupPickerVisible] = useState(false);

  // Drill-down
  const [selectedA, setSelectedA] = useState<string | null>(null);
  const [selectedB, setSelectedB] = useState<string | null>(null);
  const [detail, setDetail] = useState<PointsAnalysisResponse | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [expandedSeasons, setExpandedSeasons] = useState<Set<string>>(new Set());

  // Build player name map from API response
  const [playerNames, setPlayerNames] = useState<Record<string, string>>({});
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null);

  // Resolve logged-in user's player ID once
  useEffect(() => {
    (async () => {
      try {
        const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
        const token = await getStoredAccessToken();
        const anonKey = getSupabaseAnonKey();
        if (!base || !token) return;
        const res = await fetch(`${base}/rest/v1/rpc/get_my_player_ids`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            apikey: anonKey || token,
          },
          body: '{}',
        });
        if (res.ok) {
          const ids: string[] = await res.json();
          if (ids.length > 0) setMyPlayerId(ids[0]);
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  // Load matrix when group or sig toggle changes
  useEffect(() => {
    if (!groupId) { setMatrix(null); return; }
    let cancelled = false;
    setLoadingMatrix(true);
    setError(null);
    setDetail(null);
    setSelectedA(null);
    setSelectedB(null);

    (async () => {
      try {
        const result = await getPointsMatrix(groupId, undefined, excludeSig);
        if (cancelled) return;
        const names: Record<string, string> = {};
        for (const p of result.players) names[p.id] = p.display_name;
        setPlayerNames(names);
        const ids = result.players.map(p => p.id);
        setMatrix({ playerIds: ids, playerNames: names, cells: result.cells });
        // Default matchup picker to logged-in user if they're in the matrix
        if (myPlayerId && ids.includes(myPlayerId)) {
          setMatchupPlayer(myPlayerId);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadingMatrix(false);
      }
    })();
    return () => { cancelled = true; };
  }, [groupId, excludeSig]);

  // Drill into a pair
  const drillDown = useCallback(async (a: string, b: string) => {
    if (selectedA === a && selectedB === b) {
      setSelectedA(null); setSelectedB(null); setDetail(null);
      return;
    }
    setSelectedA(a); setSelectedB(b);
    setDetail(null); setExpandedSeasons(new Set());
    setLoadingDetail(true);
    try {
      const r = await getPointsAnalysis(groupId, a, b, undefined, excludeSig);
      setDetail(r);
    } catch {} finally {
      setLoadingDetail(false);
    }
  }, [groupId, selectedA, selectedB]);

  const name = (id: string) => playerNames[id] ?? matrix?.playerNames[id] ?? id.slice(0, 8);

  const toggleSeason = (sid: string) => {
    setExpandedSeasons((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid); else next.add(sid);
      return next;
    });
  };

  // Compute worst matchups
  const matchups = (() => {
    if (!matrix) return [];
    const list: { a: string; b: string; net: number; rounds: number; avg: number }[] = [];
    if (matchupPlayer) {
      for (const b of matrix.playerIds) {
        if (b === matchupPlayer) continue;
        const cell = matrix.cells[matchupPlayer]?.[b];
        if (!cell || cell.rounds < 1) continue;
        list.push({ a: matchupPlayer, b, net: cell.net, rounds: cell.rounds, avg: cell.net / cell.rounds });
      }
      list.sort((x, y) => x.avg - y.avg);
    } else {
      for (const a of matrix.playerIds) {
        for (const b of matrix.playerIds) {
          if (a === b) continue;
          const cell = matrix.cells[a]?.[b];
          if (!cell || cell.rounds < 3) continue;
          list.push({ a, b, net: cell.net, rounds: cell.rounds, avg: cell.net / cell.rounds });
        }
      }
      list.sort((x, y) => x.avg - y.avg);
      list.splice(10);
    }
    return list;
  })();

  const fmt = (n: number) => Math.abs(n).toLocaleString('en-US');
  const fmtSigned = (n: number) => (n >= 0 ? '' : '-') + fmt(n);

  return (
    <View style={styles.screen}>
      <Header title="Analysis" onMenuPress={openDrawer} />

      <GroupBanner
        imageUrl={selectedGroup?.logo_url ?? null}
        groupName={selectedGroup?.name ?? ''}
        seasonLabel="Points Analysis"
      />

      {/* Sig Events toggle */}
      <Pressable style={styles.sigToggle} onPress={() => setExcludeSig(!excludeSig)}>
        <View style={[styles.checkbox, excludeSig && styles.checkboxChecked]}>
          {excludeSig && <Text style={styles.checkboxMark}>{'\u2713'}</Text>}
        </View>
        <Text style={styles.sigToggleText}>Exclude Signature Events</Text>
      </Pressable>

      {loadingMatrix ? (
        <ActivityIndicator style={styles.spinner} size="large" color={OLIVE} />
      ) : error ? (
        <View style={styles.errorCard}><Text style={styles.errorText}>{error}</Text></View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
          showsVerticalScrollIndicator={false}
        >
          {/* ── Matrix ── */}
          {matrix && matrix.playerIds.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Game Points Differential</Text>
              <Text style={styles.cardSubtitle}>Row player's net vs column player. Tap a cell for detail.</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View>
                  {/* Header row */}
                  <View style={styles.matrixRow}>
                    <View style={styles.matrixNameCell} />
                    {matrix.playerIds.map((col) => (
                      <Text key={col} style={styles.matrixColHeader} numberOfLines={1}>{name(col)}</Text>
                    ))}
                  </View>
                  {/* Data rows */}
                  {matrix.playerIds.map((row) => (
                    <View key={row} style={styles.matrixRow}>
                      <Text style={styles.matrixNameCell} numberOfLines={1}>{name(row)}</Text>
                      {matrix.playerIds.map((col) => {
                        if (row === col) return <Text key={col} style={styles.matrixCell}>—</Text>;
                        const cell = matrix.cells[row]?.[col];
                        if (!cell || cell.rounds === 0) return <Text key={col} style={styles.matrixCell}>—</Text>;
                        const isSelected = selectedA === row && selectedB === col;
                        return (
                          <Pressable key={col} onPress={() => drillDown(row, col)}>
                            <Text style={[
                              styles.matrixCell,
                              { color: cell.net > 0 ? colors.positive : cell.net < 0 ? colors.negative : '#333' },
                              isSelected && { backgroundColor: '#E3F2FD' },
                            ]}>
                              {fmtSigned(cell.net)}
                              <Text style={styles.matrixRounds}> ({cell.rounds})</Text>
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  ))}
                </View>
              </ScrollView>
              <View style={styles.footnoteRow}>
                <Text style={styles.footnote}>* 2023+ seasons. Parentheses = shared rounds.</Text>
                <Text style={[styles.sigBadge, { color: excludeSig ? '#C62828' : '#2E7D32' }]}>
                  Sig Events: {excludeSig ? 'excluded' : 'included'}
                </Text>
              </View>
            </View>
          )}

          {/* ── Worst Matchups ── */}
          {matrix && matrix.playerIds.length > 0 && (
            <View style={styles.card}>
              <View style={styles.matchupHeader}>
                <Text style={styles.cardTitle}>
                  {matchupPlayer ? `${name(matchupPlayer)} vs All` : '2023+ Worst Match Ups'}
                </Text>
                <Pressable style={styles.matchupPickerBtn} onPress={() => setMatchupPickerVisible(true)}>
                  <Text style={styles.matchupPickerText}>{matchupPlayer ? name(matchupPlayer) : 'All Players'}</Text>
                  <Text style={styles.matchupChevron}>{'\u25BE'}</Text>
                </Pressable>
              </View>
              <Text style={[styles.sigBadge, { color: excludeSig ? '#C62828' : '#2E7D32', marginBottom: 6 }]}>
                Signature Events: {excludeSig ? 'excluded' : 'included'}
              </Text>
              {matchups.length === 0 ? (
                <Text style={styles.cardSubtitle}>No matchups with enough rounds.</Text>
              ) : (
                <View>
                  <View style={styles.matchupRow}>
                    <Text style={[styles.matchupCell, { width: 24 }]}>#</Text>
                    {!matchupPlayer && <Text style={[styles.matchupCell, { flex: 1 }]}>Player</Text>}
                    <Text style={[styles.matchupCell, { flex: 1 }]}>vs</Text>
                    <Text style={[styles.matchupCell, { width: 52 }]}>Avg/Rd</Text>
                    <Text style={[styles.matchupCell, { width: 60 }]}>Total</Text>
                    <Text style={[styles.matchupCell, { width: 36 }]}>Rds</Text>
                  </View>
                  {matchups.map((m, i) => (
                    <Pressable key={`${m.a}-${m.b}`} style={styles.matchupRow} onPress={() => drillDown(m.a, m.b)}>
                      <Text style={[styles.matchupCell, { width: 24, color: '#999' }]}>{i + 1}</Text>
                      {!matchupPlayer && <Text style={[styles.matchupCell, { flex: 1, fontWeight: '600' }]}>{name(m.a)}</Text>}
                      <Text style={[styles.matchupCell, { flex: 1 }]}>{name(m.b)}</Text>
                      <Text style={[styles.matchupCell, { width: 52, fontWeight: '600', color: m.avg > 0 ? colors.positive : m.avg < 0 ? colors.negative : '#333' }]}>
                        {m.avg > 0 ? '+' : ''}{m.avg.toFixed(1)}
                      </Text>
                      <Text style={[styles.matchupCell, { width: 60, color: m.net > 0 ? colors.positive : m.net < 0 ? colors.negative : '#333' }]}>
                        {fmtSigned(m.net)}
                      </Text>
                      <Text style={[styles.matchupCell, { width: 36, color: '#999' }]}>{m.rounds}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>
          )}

          {/* ── Drill-down detail ── */}
          {loadingDetail && <ActivityIndicator style={styles.spinner} size="large" color={OLIVE} />}

          {detail && detail.lifetime.rounds_together > 0 && (
            <>
              <View style={styles.card}>
                <View style={styles.detailHeader}>
                  <Text style={styles.cardTitle}>{detail.player_a.display_name} vs {detail.player_b.display_name}</Text>
                  <Pressable onPress={() => { setSelectedA(null); setSelectedB(null); setDetail(null); }}>
                    <Text style={styles.closeBtn}>{'\u2715'}</Text>
                  </Pressable>
                </View>
                <Text style={styles.lifetimeSummary}>
                  <Text style={{ fontWeight: '700' }}>{detail.player_a.display_name}</Text>
                  {' is '}
                  <Text style={{
                    fontWeight: '700',
                    color: detail.lifetime.net_points > 0 ? colors.positive : detail.lifetime.net_points < 0 ? colors.negative : '#333',
                  }}>
                    {detail.lifetime.net_points > 0 ? '+' : ''}{detail.lifetime.net_points.toLocaleString('en-US')}
                  </Text>
                  {' game points vs '}
                  <Text style={{ fontWeight: '700' }}>{detail.player_b.display_name}</Text>
                  {' across '}
                  <Text style={{ fontWeight: '700' }}>{detail.lifetime.rounds_together}</Text>
                  {' rounds, avg '}
                  <Text style={{ fontWeight: '700' }}>
                    {(detail.lifetime.net_points / detail.lifetime.rounds_together).toFixed(1)}
                  </Text>
                  {' per round.'}
                </Text>
                <View style={styles.wltRow}>
                  <View style={styles.wltItem}>
                    <Text style={[styles.wltNum, { color: colors.positive }]}>{detail.lifetime.player_a_wins}</Text>
                    <Text style={styles.wltLabel}>Wins</Text>
                  </View>
                  <View style={styles.wltItem}>
                    <Text style={[styles.wltNum, { color: colors.negative }]}>{detail.lifetime.player_b_wins}</Text>
                    <Text style={styles.wltLabel}>Losses</Text>
                  </View>
                  <View style={styles.wltItem}>
                    <Text style={[styles.wltNum, { color: '#999' }]}>{detail.lifetime.ties}</Text>
                    <Text style={styles.wltLabel}>Ties</Text>
                  </View>
                </View>
              </View>

              {/* Season breakdown */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Season-by-Season</Text>
                <View style={styles.seasonHeader}>
                  <Text style={[styles.sCol, { flex: 1 }]}>Season</Text>
                  <Text style={[styles.sCol, { width: 32 }]}>Rds</Text>
                  <Text style={[styles.sCol, { width: 44 }]}>Diff</Text>
                  <Text style={[styles.sCol, { width: 44 }]}>Avg</Text>
                </View>
                {detail.by_season.map((s) => {
                  const key = s.season_id ?? 'none';
                  const isExp = expandedSeasons.has(key);
                  const avg = s.rounds_together > 0 ? s.net_points / s.rounds_together : 0;
                  return (
                    <View key={key}>
                      <Pressable style={styles.seasonRow} onPress={() => toggleSeason(key)}>
                        <Text style={[styles.sCell, { flex: 1, fontWeight: '500' }]}>
                          {isExp ? '\u25BC' : '\u25B6'} {s.season_name}
                        </Text>
                        <Text style={[styles.sCell, { width: 32 }]}>{s.rounds_together}</Text>
                        <Text style={[styles.sCell, { width: 44, fontWeight: '600', color: s.net_points > 0 ? colors.positive : s.net_points < 0 ? colors.negative : '#333' }]}>
                          {s.net_points > 0 ? '+' : ''}{s.net_points}
                        </Text>
                        <Text style={[styles.sCell, { width: 44, color: avg > 0 ? colors.positive : avg < 0 ? colors.negative : '#333' }]}>
                          {avg.toFixed(1)}
                        </Text>
                      </Pressable>
                      {isExp && s.rounds.map((rd) => (
                        <View key={rd.league_round_id} style={styles.roundRow}>
                          <Text style={[styles.sCell, { flex: 1, color: '#666', paddingLeft: 20 }]}>
                            {new Date(rd.round_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </Text>
                          <Text style={[styles.sCell, { width: 32 }]}> </Text>
                          <Text style={[styles.sCell, { width: 44, fontWeight: '600', color: rd.net > 0 ? colors.positive : rd.net < 0 ? colors.negative : '#333' }]}>
                            {rd.net > 0 ? '+' : ''}{rd.net}
                          </Text>
                          <Text style={[styles.sCell, { width: 44, color: '#666' }]}>
                            {rd.net > 0 ? detail.player_a.display_name.split(' ')[0] : rd.net < 0 ? detail.player_b.display_name.split(' ')[0] : 'Tie'}
                          </Text>
                        </View>
                      ))}
                    </View>
                  );
                })}
              </View>
            </>
          )}
        </ScrollView>
      )}

      {/* Group selection is in the hamburger drawer */}

      {/* Matchup player picker */}
      <Modal visible={matchupPickerVisible} animationType="slide" transparent>
        <View style={styles.modalWrap}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setMatchupPickerVisible(false)} />
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.modalTitle}>Filter Player</Text>
            <Pressable
              style={[styles.modalRow, !matchupPlayer && styles.modalRowSelected]}
              onPress={() => { setMatchupPlayer(''); setMatchupPickerVisible(false); }}
            >
              <Text style={[styles.modalRowText, !matchupPlayer && { color: OLIVE }]}>All Players</Text>
            </Pressable>
            <FlatList
              data={matrix?.playerIds ?? []}
              keyExtractor={(id) => id}
              renderItem={({ item }) => {
                const isSel = matchupPlayer === item;
                return (
                  <Pressable
                    style={[styles.modalRow, isSel && styles.modalRowSelected]}
                    onPress={() => { setMatchupPlayer(item); setMatchupPickerVisible(false); }}
                  >
                    <Text style={[styles.modalRowText, isSel && { color: OLIVE }]}>{name(item)}</Text>
                  </Pressable>
                );
              }}
            />
            <Pressable style={styles.modalCancel} onPress={() => setMatchupPickerVisible(false)}>
              <Text style={{ fontWeight: '600', color: OLIVE }}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F5F5F5' },
  headerWrap: { position: 'relative' },
  headerCenter: {
    position: 'absolute', left: 0, right: 0, bottom: 0, top: 0,
    justifyContent: 'center', alignItems: 'center', pointerEvents: 'box-none',
  },
  spinner: { marginVertical: 40 },
  errorCard: { backgroundColor: '#FFEBEE', borderRadius: 10, padding: 14, margin: 16 },
  errorText: { color: '#C62828', fontSize: 14 },

  card: {
    backgroundColor: '#FFF', borderRadius: 12, marginHorizontal: 12, marginTop: 12,
    padding: 14, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 4, elevation: 2,
  },
  cardTitle: { fontSize: 17, fontWeight: '700', color: '#1A1A1A', marginBottom: 4 },
  cardSubtitle: { fontSize: 12, color: '#8E8E93', marginBottom: 8 },
  footnoteRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  footnote: { fontSize: 10, color: '#AAA' },
  sigBadge: { fontSize: 10, fontWeight: '600' },
  sigToggle: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  sigToggleText: { fontSize: 14, color: '#333' },
  checkbox: { width: 20, height: 20, borderRadius: 4, borderWidth: 1.5, borderColor: '#999', justifyContent: 'center', alignItems: 'center' },
  checkboxChecked: { backgroundColor: OLIVE, borderColor: OLIVE },
  checkboxMark: { color: '#FFF', fontSize: 13, fontWeight: '700' },

  // Matrix
  matrixRow: { flexDirection: 'row', alignItems: 'center' },
  matrixNameCell: { width: 56, fontSize: 11, fontWeight: '600', color: '#1A1A1A', paddingVertical: 6, paddingRight: 4 },
  matrixColHeader: { width: 56, fontSize: 10, fontWeight: '600', color: '#8E8E93', textAlign: 'center', paddingVertical: 4 },
  matrixCell: { width: 56, fontSize: 11, textAlign: 'center', paddingVertical: 6, fontWeight: '600' },
  matrixRounds: { fontSize: 9, color: '#AAA', fontWeight: '400' },

  // Matchups
  matchupHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  matchupPickerBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: OLIVE, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, gap: 4 },
  matchupPickerText: { color: '#FFF', fontSize: 12, fontWeight: '600' },
  matchupChevron: { color: '#FFF', fontSize: 10 },
  matchupRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#EEE' },
  matchupCell: { fontSize: 13, color: '#1A1A1A' },

  // Detail
  detailHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  closeBtn: { fontSize: 18, color: '#8E8E93', padding: 4 },
  lifetimeSummary: { fontSize: 15, lineHeight: 22, color: '#333', marginBottom: 12 },
  wltRow: { flexDirection: 'row', gap: 24 },
  wltItem: { alignItems: 'center' },
  wltNum: { fontSize: 22, fontWeight: '700' },
  wltLabel: { fontSize: 11, color: '#8E8E93', marginTop: 2 },

  // Season table
  seasonHeader: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#E0E0E0' },
  sCol: { fontSize: 10, fontWeight: '700', color: '#8E8E93', textTransform: 'uppercase' },
  seasonRow: { flexDirection: 'row', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#EEE' },
  sCell: { fontSize: 13 },
  roundRow: { flexDirection: 'row', paddingVertical: 6, backgroundColor: '#FAFAFA', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#F0F0F0' },

  // Modal
  modalWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#FFF', borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingHorizontal: 16, paddingTop: 16, maxHeight: '70%' },
  modalTitle: { fontSize: 18, fontWeight: '700', marginBottom: 12 },
  modalRow: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#EEE' },
  modalRowSelected: { backgroundColor: '#F0F4E8' },
  modalRowText: { fontSize: 16, fontWeight: '500' },
  modalCancel: { paddingVertical: 16, alignItems: 'center' },
});
