import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import {
  ApiError,
  apiFetch,
  getEvent,
  getStoredAccessToken,
  type EventDetail,
  type EventResult,
} from '@/lib/api';
import { getApiBase, getSupabaseAnonKey } from '@/lib/config';

type PaymentRow = {
  from_player_id: string;
  from_name: string;
  to_player_id: string;
  to_name: string;
  to_venmo: string | null;
  amount_cents: number;
};

import { useGroup } from '@/contexts/GroupContext';

export default function RoundDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const { isSuperAdmin, isGroupAdmin, invalidateData } = useGroup();
  const colors = Colors[colorScheme ?? 'light'];
  const router = useRouter();

  const [event, setEvent] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [payoutMode, setPayoutMode] = useState<'quick' | 'full'>('quick');
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [payoutLoading, setPayoutLoading] = useState(false);
  const [payoutError, setPayoutError] = useState<string | null>(null);
  const [payoutLoaded, setPayoutLoaded] = useState(false);

  // Player venmo handles + group info
  const [venmoHandles, setVenmoHandles] = useState<Record<string, string | null>>({});
  const [groupName, setGroupName] = useState('');
  const [dollarsPerPoint, setDollarsPerPoint] = useState<number | null>(null);

  // Permission: can this user edit/delete this round?
  const canEdit = isSuperAdmin || (event ? isGroupAdmin(event.group_id) : false);

  // Edit/Delete state
  const [editing, setEditing] = useState(false);
  const [editScores, setEditScores] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getEvent(id)
      .then((ev) => {
        if (!cancelled) setEvent(ev);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Fetch venmo handles + group dollars_per_point after event loads
  useEffect(() => {
    if (!event) return;
    (async () => {
      const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
      const token = await getStoredAccessToken();
      const anonKey = getSupabaseAnonKey();
      if (!base || !token) return;
      const headers = { Authorization: `Bearer ${token}`, apikey: anonKey || token };
      try {
        // Fetch player venmo handles
        const playerIds = event.results.map((r) => r.player_id);
        const inList = playerIds.map((id) => `"${id}"`).join(',');
        const pRes = await fetch(`${base}/rest/v1/players?id=in.(${inList})&select=id,venmo_handle`, { headers });
        if (pRes.ok) {
          const players: { id: string; venmo_handle: string | null }[] = await pRes.json();
          const map: Record<string, string | null> = {};
          for (const p of players) map[p.id] = p.venmo_handle;
          setVenmoHandles(map);
        }
        // Fetch group info
        const gRes = await fetch(`${base}/rest/v1/groups?id=eq.${event.group_id}&select=name,dollars_per_point`, { headers });
        if (gRes.ok) {
          const groups = await gRes.json();
          if (groups.length > 0) {
            setGroupName(groups[0].name ?? '');
            setDollarsPerPoint(groups[0].dollars_per_point);
          }
        }
      } catch {}
    })();
  }, [event]);

  const startEdit = () => {
    if (!event) return;
    const scores: Record<string, string> = {};
    for (const r of event.results) {
      scores[r.player_id] = String(r.game_points ?? r.score_value ?? 0);
    }
    setEditScores(scores);
    setEditing(true);
    setActionMsg(null);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditScores({});
    setActionMsg(null);
  };

  const saveEdit = async () => {
    if (!event || !id) return;
    setSaving(true);
    setActionMsg(null);
    try {
      // Build scores with game_points
      const scores = event.results.map((r) => ({
        player_id: r.player_id,
        game_points: parseFloat(editScores[r.player_id] ?? '0'),
      }));
      const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
      const token = await getStoredAccessToken();
      const anonKey = getSupabaseAnonKey();
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: anonKey || token || '',
        Prefer: 'return=minimal',
      };

      // Compute new h2h values
      const N = scores.length;
      const total = scores.reduce((s, sc) => s + sc.game_points, 0);
      const insertRows = scores.map((sc) => ({
        id: crypto.randomUUID(),
        league_round_id: id,
        player_id: sc.player_id,
        game_points: sc.game_points,
        score_value: N * sc.game_points - total,
      }));

      // Delete old scores — check response
      const delRes = await fetch(`${base}/rest/v1/league_scores?league_round_id=eq.${id}`, { method: 'DELETE', headers });
      if (!delRes.ok) {
        const text = await delRes.text();
        throw new Error(`Failed to delete existing scores: ${delRes.status} ${text}`);
      }

      // Insert new scores — check response
      const insRes = await fetch(`${base}/rest/v1/league_scores`, {
        method: 'POST',
        headers,
        body: JSON.stringify(insertRows),
      });
      if (!insRes.ok) {
        const text = await insRes.text();
        throw new Error(`Failed to save new scores: ${insRes.status} ${text}`);
      }

      // Reload
      const ev = await getEvent(id);
      setEvent(ev);
      setEditing(false);
      setActionMsg('Saved');
      invalidateData();
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);

  const confirmDelete = () => setDeleteConfirmVisible(true);
  const cancelDelete = () => setDeleteConfirmVisible(false);

  const executeDelete = async () => {
    if (!id) return;
    setDeleteConfirmVisible(false);
    setActionMsg(null);
    try {
      const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
      const token = await getStoredAccessToken();
      const anonKey = getSupabaseAnonKey();
      if (!base || !token) throw new Error('Not signed in');
      const headers = {
        Authorization: `Bearer ${token}`,
        apikey: anonKey || token,
        Prefer: 'return=minimal',
      };

      // Delete scores first (FK child), then round
      const scoresRes = await fetch(`${base}/rest/v1/league_scores?league_round_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers });
      if (!scoresRes.ok) {
        const text = await scoresRes.text();
        console.error('Delete scores failed:', scoresRes.status, text);
        throw new Error(`Failed to delete scores: ${scoresRes.status}`);
      }

      const roundRes = await fetch(`${base}/rest/v1/league_rounds?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers });
      if (!roundRes.ok) {
        const text = await roundRes.text();
        console.error('Delete round failed:', roundRes.status, text);
        throw new Error(`Failed to delete round: ${roundRes.status}`);
      }

      invalidateData();
      router.back();
    } catch (e) {
      console.error('Delete error:', e);
      const msg = e instanceof Error ? e.message : 'Delete failed';
      setActionMsg(msg.includes('permission') || msg.includes('policy') || msg.includes('403')
        ? "You don't have permission to delete this round"
        : msg);
    }
  };

  const playerNameMap = useCallback((): Map<string, string> => {
    const map = new Map<string, string>();
    if (event?.results) {
      for (const r of event.results) {
        map.set(r.player_id, r.player_name ?? r.player_id.slice(0, 8));
      }
    }
    return map;
  }, [event]);

  const effectivePoints = (r: EventResult): number => {
    const raw = r.score_override ?? r.score_value;
    if (raw == null) return 0;
    return Math.round(raw);
  };

  const gamePoints = (r: EventResult): number | null => {
    if (r.game_points != null) return Math.round(r.game_points);
    return null; // legacy round — no raw game points available
  };

  const formatDate = (dateStr: string): string => {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  const getSeasonYear = (dateStr: string): string => {
    const d = new Date(dateStr + 'T00:00:00');
    return `${d.getFullYear()} SEASON`;
  };

  const formatRoundDateShort = (d: string) => {
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const openVenmo = (toPlayerId: string, amount: number) => {
    const handle = venmoHandles[toPlayerId];
    if (!handle) return;
    const note = `${groupName || 'Late Add'} Golf - ${event ? formatRoundDateShort(event.round_date) : ''}`;
    const url = `https://venmo.com/${encodeURIComponent(handle)}?txn=pay&amount=${amount.toFixed(2)}&note=${encodeURIComponent(note)}`;
    Linking.openURL(url).catch(() => {});
  };

  // Compute payouts client-side from score_value × dollars_per_point
  const computePayouts = useCallback(() => {
    if (!event || !dollarsPerPoint) {
      setPayments([]);
      setPayoutLoaded(true);
      return;
    }
    const names = playerNameMap();
    const players = event.results.map((r) => ({
      id: r.player_id,
      name: names.get(r.player_id) ?? r.player_id.slice(0, 8),
      eff: effectivePoints(r),
      gp: r.game_points ?? null,
    }));
    const dpp = dollarsPerPoint;
    const hasGamePoints = players.every((p) => p.gp !== null);

    if (payoutMode === 'quick') {
      // Minimized: sort by amount, match biggest loser with biggest winner
      const losers = players.filter((p) => p.eff < 0).map((p) => ({ ...p, remaining: Math.round(Math.abs(p.eff * dpp) * 100) }));
      const winners = players.filter((p) => p.eff > 0).map((p) => ({ ...p, remaining: Math.round(p.eff * dpp * 100) }));
      losers.sort((a, b) => b.remaining - a.remaining);
      winners.sort((a, b) => b.remaining - a.remaining);

      const rows: PaymentRow[] = [];
      for (const loser of losers) {
        for (const winner of winners) {
          if (loser.remaining <= 0 || winner.remaining <= 0) continue;
          const transfer = Math.min(loser.remaining, winner.remaining);
          loser.remaining -= transfer;
          winner.remaining -= transfer;
          rows.push({
            from_player_id: loser.id, from_name: loser.name,
            to_player_id: winner.id, to_name: winner.name,
            to_venmo: venmoHandles[winner.id] ?? null,
            amount_cents: transfer,
          });
        }
      }
      setPayments(rows);
    } else {
      // Full: each player pays every player who scored higher the difference in game points
      // Formula: B pays A = (game_points_A - game_points_B) × dollars_per_point
      // Requires game_points; falls back to score_value proportional if not available
      const rows: PaymentRow[] = [];
      if (hasGamePoints) {
        // Sort by game_points descending
        const sorted = [...players].sort((a, b) => (b.gp ?? 0) - (a.gp ?? 0));
        for (let i = 0; i < sorted.length; i++) {
          for (let j = i + 1; j < sorted.length; j++) {
            const higher = sorted[i];
            const lower = sorted[j];
            const diff = ((higher.gp ?? 0) - (lower.gp ?? 0)) * dpp;
            const amountCents = Math.round(diff * 100);
            if (amountCents <= 0) continue;
            rows.push({
              from_player_id: lower.id, from_name: lower.name,
              to_player_id: higher.id, to_name: higher.name,
              to_venmo: venmoHandles[higher.id] ?? null,
              amount_cents: amountCents,
            });
          }
        }
      } else {
        // Fallback for legacy rounds without game_points: use score_value proportional
        const losers = players.filter((p) => p.eff < 0);
        const winners = players.filter((p) => p.eff > 0);
        const totalWinCents = winners.reduce((s, w) => s + Math.round(w.eff * dpp * 100), 0);
        for (const loser of losers) {
          const loserOwes = Math.round(Math.abs(loser.eff * dpp) * 100);
          for (const winner of winners) {
            const winnerShare = Math.round(winner.eff * dpp * 100);
            const amount = totalWinCents > 0 ? Math.round(loserOwes * winnerShare / totalWinCents) : 0;
            if (amount <= 0) continue;
            rows.push({
              from_player_id: loser.id, from_name: loser.name,
              to_player_id: winner.id, to_name: winner.name,
              to_venmo: venmoHandles[winner.id] ?? null,
              amount_cents: amount,
            });
          }
        }
      }
      setPayments(rows);
    }
    setPayoutLoaded(true);
  }, [event, dollarsPerPoint, payoutMode, venmoHandles, playerNameMap]);

  // Trigger payout computation when dependencies change
  useEffect(() => {
    if (!event || dollarsPerPoint == null) return;
    setPayoutLoaded(false);
    setPayments([]);
    setPayoutError(null);
    computePayouts();
  }, [payoutMode, event, dollarsPerPoint, computePayouts]);

  return (
    <View style={styles.screen}>
      {/* Olive green header */}
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <View style={styles.headerRow}>
          <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backButton}>
            <Text style={styles.backArrow}>{'\u2039'}</Text>
          </Pressable>
          <Text style={styles.headerTitle}>Round Details</Text>
          <View style={styles.backButton} />
        </View>
      </View>

      {loading ? (
        <ActivityIndicator style={styles.spinner} size="large" color={OLIVE} />
      ) : error ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : event ? (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          showsVerticalScrollIndicator={false}>

          {/* Date/season info section */}
          <View style={styles.dateSection}>
            <Text style={styles.seasonLabel}>{getSeasonYear(event.round_date)}</Text>
            <View style={styles.dateRow}>
              <Text style={styles.dateText}>{formatDate(event.round_date)}</Text>
              {canEdit && (
                <View style={styles.dateActions}>
                  <Pressable style={styles.editPill} onPress={startEdit}>
                    <Text style={styles.editPillText}>{'\u270E'} Edit</Text>
                  </Pressable>
                  <Pressable onPress={confirmDelete} hitSlop={8}>
                    <Text style={styles.deleteBtn}>{'\u2715'}</Text>
                  </Pressable>
                </View>
              )}
            </View>
          </View>

          {/* Tournament banner */}
          {event.is_tournament === 1 && (
            <View style={styles.tournamentBanner}>
              <Text style={styles.tournamentBannerText}>
                {'\uD83C\uDFC6'} Tournament Round — {event.tournament_buyin ?? 0} pt buy-in
              </Text>
            </View>
          )}

          {/* Action message */}
          {actionMsg && (
            <View style={[styles.msgBanner, { backgroundColor: actionMsg === 'Saved' ? '#E8F5E9' : '#FFEBEE' }]}>
              <Text style={{ color: actionMsg === 'Saved' ? '#2E7D32' : '#C62828', fontSize: 14 }}>{actionMsg}</Text>
            </View>
          )}

          {/* Players card */}
          <View style={styles.playersCard}>
            <View style={styles.playersHeader}>
              <Text style={styles.playersTitle}>Players</Text>
            </View>

            {/* Table header */}
            <View style={styles.tableHeader}>
              <Text style={[styles.tableHeaderCell, { flex: 1, textAlign: 'left' }]}>PLAYER</Text>
              <Text style={[styles.tableHeaderCell, { width: 80 }]}>GAME PTS.</Text>
              <Text style={[styles.tableHeaderCell, { width: 60 }]}>+/-</Text>
            </View>

            {/* Player rows */}
            {event.results && event.results.length > 0 ? (
              event.results.map((r) => {
                const eff = effectivePoints(r);
                const gp = gamePoints(r);
                if (editing) {
                  // Edit mode: show text input for game_points
                  const editVal = editScores[r.player_id] ?? '';
                  const editNum = parseFloat(editVal);
                  const N = event.results.length;
                  const total = Object.values(editScores).reduce((s, v) => s + (parseFloat(v) || 0), 0);
                  const previewH2h = !isNaN(editNum) ? Math.round(N * editNum - total) : null;
                  return (
                    <View key={r.player_id} style={styles.playerRow}>
                      <Text style={[styles.playerName, { flex: 1 }]} numberOfLines={1}>
                        {r.player_name ?? r.player_id.slice(0, 8)}
                      </Text>
                      <TextInput
                        style={styles.editInput}
                        value={editVal}
                        onChangeText={(v) => setEditScores((prev) => ({ ...prev, [r.player_id]: v }))}
                        keyboardType="numeric"
                        selectTextOnFocus
                      />
                      <View style={{ width: 60, alignItems: 'flex-end' }}>
                        <Text style={{ fontSize: 14, color: previewH2h != null ? (previewH2h > 0 ? '#2E7D32' : previewH2h < 0 ? '#C62828' : '#666') : '#999' }}>
                          {previewH2h != null ? (previewH2h > 0 ? `+${previewH2h}` : `${previewH2h}`) : '—'}
                        </Text>
                      </View>
                    </View>
                  );
                }
                return (
                  <View key={r.player_id} style={styles.playerRow}>
                    <Text style={[styles.playerName, { flex: 1 }]} numberOfLines={1}>
                      {r.player_name ?? r.player_id.slice(0, 8)}
                    </Text>
                    <Text style={[styles.playerScore, { width: 80 }]}>{gp !== null ? gp : '—'}</Text>
                    <View style={{ width: 60, alignItems: 'flex-end' }}>
                      {eff > 0 ? (
                        <View style={styles.positivePill}>
                          <Text style={styles.positiveText}>+{eff}</Text>
                        </View>
                      ) : eff < 0 ? (
                        <Text style={styles.negativeText}>{eff}</Text>
                      ) : (
                        <Text style={styles.neutralText}>0</Text>
                      )}
                    </View>
                  </View>
                );
              })
            ) : (
              <Text style={styles.emptyText}>No results recorded.</Text>
            )}

            {/* Edit mode buttons */}
            {editing && (
              <View style={styles.editButtons}>
                <Pressable style={styles.editCancelBtn} onPress={cancelEdit} disabled={saving}>
                  <Text style={styles.editCancelText}>Cancel</Text>
                </Pressable>
                <Pressable style={[styles.editSaveBtn, saving && { opacity: 0.5 }]} onPress={saveEdit} disabled={saving}>
                  <Text style={styles.editSaveText}>{saving ? 'Saving...' : 'Save Scores'}</Text>
                </Pressable>
              </View>
            )}
          </View>

          {/* Payout section — only show if group has dollars_per_point */}
          {dollarsPerPoint != null && dollarsPerPoint > 0 && (
            <View style={styles.payoutSection}>
              {/* Toggle buttons */}
              <View style={styles.toggleRow}>
                <Pressable
                  style={[styles.toggleBtn, payoutMode === 'quick' && styles.toggleBtnActive]}
                  onPress={() => setPayoutMode('quick')}>
                  <Text style={[styles.toggleBtnText, payoutMode === 'quick' && styles.toggleBtnTextActive]}>
                    {'\u26A1'} Quick Payout
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.toggleBtn, payoutMode === 'full' && styles.toggleBtnActive]}
                  onPress={() => setPayoutMode('full')}>
                  <Text style={[styles.toggleBtnText, payoutMode === 'full' && styles.toggleBtnTextActive]}>
                    $ Payout
                  </Text>
                </Pressable>
              </View>

              {/* Section header */}
              <Text style={styles.payoutSectionTitle}>
                {'\uD83D\uDCB8'} {payoutMode === 'quick' ? 'QUICK PAYOUT' : 'PAYOUT'}
              </Text>

              {payoutLoaded && payments.length === 0 ? (
                <Text style={styles.noPayouts}>No payouts needed — all even.</Text>
              ) : payments.length > 0 ? (
                <View style={styles.payoutList}>
                  {payments.map((p, i) => (
                    <View key={`${p.from_player_id}-${p.to_player_id}-${i}`} style={styles.payoutRow}>
                      <Text style={styles.payoutText} numberOfLines={1}>
                        {p.from_name} pays {p.to_name}{' '}
                        <Text style={styles.payoutAmount}>${Math.round(p.amount_cents / 100)}</Text>
                      </Text>
                      {p.to_venmo ? (
                        <Pressable
                          style={styles.venmoBtn}
                          onPress={() => openVenmo(p.to_player_id, p.amount_cents / 100)}>
                          <Text style={styles.venmoBtnText}>Venmo</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          )}
        </ScrollView>
      ) : null}

      {/* Delete confirmation modal */}
      <Modal visible={deleteConfirmVisible} animationType="fade" transparent>
        <View style={styles.confirmOverlay}>
          <View style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>Delete Round?</Text>
            <Text style={styles.confirmMsg}>This will permanently delete this round and all its scores. This cannot be undone.</Text>
            <View style={styles.confirmButtons}>
              <Pressable style={styles.confirmCancelBtn} onPress={cancelDelete}>
                <Text style={styles.confirmCancelText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.confirmDeleteBtn} onPress={executeDelete}>
                <Text style={styles.confirmDeleteText}>Delete</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const OLIVE = '#4B5E2A';

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
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
  scrollView: {
    flex: 1,
  },
  spinner: {
    marginVertical: 40,
  },

  /* Date section */
  dateSection: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
  },
  seasonLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: OLIVE,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  dateRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dateText: {
    fontSize: 26,
    fontWeight: '700',
    color: '#1A1A1A',
  },
  dateActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  editPill: {
    backgroundColor: OLIVE,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  editPillText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  deleteBtn: {
    fontSize: 18,
    color: '#C62828',
    fontWeight: '600',
    padding: 4,
  },
  tournamentBanner: {
    backgroundColor: '#FFF8E1',
    borderRadius: 10,
    padding: 12,
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#FFE082',
  },
  tournamentBannerText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#F57F17',
    textAlign: 'center',
  },
  msgBanner: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 10,
    borderRadius: 8,
  },
  editInput: {
    width: 80,
    borderWidth: 1,
    borderColor: '#DDD',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 16,
    textAlign: 'center',
    backgroundColor: '#FFF',
    color: '#1A1A1A',
  },
  editButtons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E0E0E0',
  },
  editCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#CCC',
    alignItems: 'center',
  },
  editCancelText: { fontSize: 15, fontWeight: '600', color: '#666' },
  editSaveBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: OLIVE,
    alignItems: 'center',
  },
  editSaveText: { fontSize: 15, fontWeight: '600', color: '#FFF' },
  menuDots: {
    fontSize: 22,
    color: '#8E8E93',
    fontWeight: '700',
  },

  /* Players card */
  playersCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E0E0E0',
    margin: 16,
    padding: 16,
  },
  playersHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  playersTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1A1A1A',
  },
  tableHeader: {
    flexDirection: 'row',
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
    marginBottom: 4,
  },
  tableHeaderCell: {
    fontSize: 11,
    fontWeight: '700',
    color: '#8E8E93',
    textAlign: 'right',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  playerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#F0F0F0',
  },
  playerName: {
    fontSize: 15,
    color: '#1A1A1A',
    fontWeight: '500',
  },
  playerScore: {
    fontSize: 15,
    color: '#1A1A1A',
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  positivePill: {
    backgroundColor: '#E8F5E9',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  positiveText: {
    color: '#2E7D32',
    fontSize: 14,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  negativeText: {
    color: '#C62828',
    fontSize: 14,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  neutralText: {
    color: '#8E8E93',
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
  emptyText: {
    textAlign: 'center',
    color: '#8E8E93',
    fontSize: 15,
    paddingVertical: 20,
  },

  /* Payout section */
  payoutSection: {
    marginHorizontal: 16,
    marginBottom: 16,
  },
  toggleRow: {
    flexDirection: 'row',
    marginBottom: 14,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: OLIVE,
  },
  toggleBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  toggleBtnActive: {
    backgroundColor: OLIVE,
  },
  toggleBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: OLIVE,
  },
  toggleBtnTextActive: {
    color: '#FFFFFF',
  },
  payoutSectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#8E8E93',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  payoutSpinner: {
    marginVertical: 16,
  },
  noPayouts: {
    textAlign: 'center',
    color: '#8E8E93',
    fontSize: 15,
    paddingVertical: 16,
  },
  payoutList: {
    gap: 8,
  },
  payoutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E0E0E0',
    padding: 14,
  },
  payoutText: {
    flex: 1,
    fontSize: 15,
    color: '#1A1A1A',
  },
  payoutAmount: {
    fontWeight: '700',
  },
  venmoBtn: {
    backgroundColor: '#2E7D32',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginLeft: 10,
  },
  venmoBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  confirmOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  confirmCard: {
    backgroundColor: '#FFF',
    borderRadius: 14,
    padding: 24,
    width: '100%',
    maxWidth: 320,
  },
  confirmTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1A1A1A',
    marginBottom: 8,
  },
  confirmMsg: {
    fontSize: 14,
    color: '#666',
    lineHeight: 20,
    marginBottom: 20,
  },
  confirmButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  confirmCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#CCC',
    alignItems: 'center',
  },
  confirmCancelText: { fontSize: 15, fontWeight: '600', color: '#666' },
  confirmDeleteBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#C62828',
    alignItems: 'center',
  },
  confirmDeleteText: { fontSize: 15, fontWeight: '600', color: '#FFF' },
  errorCard: {
    backgroundColor: '#FFEBEE',
    borderRadius: 10,
    padding: 14,
    margin: 16,
  },
  errorText: {
    color: '#C62828',
    fontSize: 14,
  },
});
