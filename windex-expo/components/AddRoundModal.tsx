import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  apiFetch,
  listGroupMembers,
  type MemberWithPlayer,
} from '@/lib/api';
import { useGroup } from '@/contexts/GroupContext';

const OLIVE = '#4B5E2A';

type Props = {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
};

function formatDateDisplay(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase();
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function AddRoundModal({ visible, onClose, onSuccess }: Props) {
  const insets = useSafeAreaInsets();
  const { selectedGroup, selectedSeason, seasonLabel } = useGroup();

  const [members, setMembers] = useState<MemberWithPlayer[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);

  // Form state
  const [date, setDate] = useState(new Date());
  const [dateText, setDateText] = useState(toISODate(new Date()));
  const [tournament, setTournament] = useState(false);
  const [buyIn, setBuyIn] = useState('');
  const [selectedPlayers, setSelectedPlayers] = useState<Set<string>>(new Set());
  const [scores, setScores] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Load members when modal opens
  useEffect(() => {
    if (!visible || !selectedGroup) return;
    setLoadingMembers(true);
    listGroupMembers(selectedGroup.id)
      .then((m) => {
        setMembers(m.filter((mem) => mem.is_active === 1));
      })
      .catch(() => setMembers([]))
      .finally(() => setLoadingMembers(false));
  }, [visible, selectedGroup?.id]);

  // Reset form when opening
  useEffect(() => {
    if (visible) {
      const now = new Date();
      setDate(now);
      setDateText(toISODate(now));
      setTournament(false);
      setBuyIn('');
      setSelectedPlayers(new Set());
      setScores({});
      setScoreErrors({});
      setError(null);
      setSuccess(false);
    }
  }, [visible]);

  const togglePlayer = (playerId: string) => {
    setSelectedPlayers((prev) => {
      const next = new Set(prev);
      if (next.has(playerId)) {
        next.delete(playerId);
        setScores((s) => { const n = { ...s }; delete n[playerId]; return n; });
      } else {
        next.add(playerId);
      }
      return next;
    });
  };

  const [scoreErrors, setScoreErrors] = useState<Record<string, string>>({});

  const updateScore = (playerId: string, value: string) => {
    // Strip anything that's not a digit or decimal point
    const clean = value.replace(/[^0-9.]/g, '');
    setScores((prev) => ({ ...prev, [playerId]: clean }));
    // Validate
    if (value !== clean && value.includes('-')) {
      setScoreErrors((prev) => ({ ...prev, [playerId]: 'Game points must be positive' }));
    } else {
      setScoreErrors((prev) => { const n = { ...prev }; delete n[playerId]; return n; });
    }
  };

  const buyInNum = tournament ? parseFloat(buyIn) || 0 : 0;
  const N = selectedPlayers.size;
  const scoresTotal = [...selectedPlayers].reduce((s, pid) => s + (parseFloat(scores[pid] ?? '0') || 0), 0);
  const pool = N * buyInNum;
  const poolBalanced = tournament ? Math.round(scoresTotal) === Math.round(pool) : true;

  // Compute live preview of +/-
  const getFinal = (playerId: string): number | null => {
    const allFilled = [...selectedPlayers].every((pid) => {
      const v = scores[pid];
      return v !== undefined && v !== '' && !isNaN(parseFloat(v));
    });
    if (!allFilled) return null;
    const gp = parseFloat(scores[playerId] ?? '0') || 0;

    if (tournament && buyInNum > 0) {
      // Tournament: score_value = game_points - buy_in
      return gp - buyInNum;
    } else {
      // Regular: h2h = N × game_points - round_total
      const total = [...selectedPlayers].reduce((s, pid) => s + (parseFloat(scores[pid] ?? '0') || 0), 0);
      return N * gp - total;
    }
  };

  // Validation
  const allScoresFilled = [...selectedPlayers].every((pid) => {
    const v = scores[pid];
    return v !== undefined && v !== '' && !isNaN(parseFloat(v));
  });
  const isValid = dateText && selectedPlayers.size > 0 && allScoresFilled
    && (!tournament || (buyInNum > 0 && poolBalanced));

  const handleDateChange = (text: string) => {
    setDateText(text);
    const parsed = new Date(text + 'T00:00:00');
    if (!isNaN(parsed.getTime())) setDate(parsed);
  };

  const handleSubmit = useCallback(async () => {
    if (!isValid || !selectedGroup || !selectedSeason) return;
    setSubmitting(true);
    setError(null);

    const scoreEntries = [...selectedPlayers].map((pid) => {
      const gamePts = parseFloat(scores[pid] ?? '0');
      return { player_id: pid, game_points: gamePts };
    });

    try {
      await apiFetch('/ingest-event-results', {
        method: 'POST',
        body: JSON.stringify({
          group_id: selectedGroup.id,
          season_id: selectedSeason.id,
          round_date: dateText,
          source_app: 'manual',
          is_tournament: tournament ? 1 : 0,
          tournament_buyin: tournament ? buyInNum : null,
          scores: scoreEntries,
        }),
      });
      setSuccess(true);
      setTimeout(() => {
        onSuccess();
        onClose();
      }, 800);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to submit round');
    } finally {
      setSubmitting(false);
    }
  }, [isValid, selectedGroup, selectedSeason, dateText, selectedPlayers, scores, tournament, buyInNum, onSuccess, onClose]);

  const activeMembers = members.sort((a, b) => a.player.display_name.localeCompare(b.player.display_name));

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.sheetWrap}
        >
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            {/* Header */}
            <View style={styles.header}>
              <Text style={styles.title}>Add Round</Text>
              <Pressable onPress={onClose} hitSlop={8}>
                <Text style={styles.closeBtn}>{'\u2715'}</Text>
              </Pressable>
            </View>

            <ScrollView style={styles.scrollBody} showsVerticalScrollIndicator={true} keyboardShouldPersistTaps="handled">
              {/* Date */}
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>Date</Text>
                <Text style={styles.fieldRequired}>Required</Text>
              </View>
              <TextInput
                style={styles.input}
                value={dateText}
                onChangeText={handleDateChange}
                placeholder="YYYY-MM-DD"
                placeholderTextColor="#999"
                keyboardType="default"
              />
              <Text style={styles.datePreview}>{formatDateDisplay(date)}</Text>

              {/* Season (read-only) */}
              {selectedSeason && (
                <View style={styles.seasonBadge}>
                  <Text style={styles.seasonBadgeText}>{seasonLabel(selectedSeason)} Season</Text>
                </View>
              )}

              {/* Tournament toggle */}
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Tournament Round</Text>
                <Switch
                  value={tournament}
                  onValueChange={setTournament}
                  trackColor={{ false: '#DDD', true: OLIVE }}
                  thumbColor="#FFF"
                />
              </View>

              {tournament && (
                <View style={styles.buyInRow}>
                  <Text style={styles.fieldLabel}>Buy-in (points)</Text>
                  <TextInput
                    style={[styles.input, styles.buyInInput]}
                    value={buyIn}
                    onChangeText={setBuyIn}
                    placeholder="25"
                    placeholderTextColor="#999"
                    keyboardType="numeric"
                  />
                </View>
              )}

              {/* Players */}
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>Players</Text>
                <Text style={styles.fieldRequired}>Required</Text>
              </View>

              {loadingMembers ? (
                <ActivityIndicator style={{ marginVertical: 12 }} color={OLIVE} />
              ) : (
                <View style={styles.chipContainer}>
                  {activeMembers.map((m) => {
                    const isSelected = selectedPlayers.has(m.player_id);
                    return (
                      <Pressable
                        key={m.player_id}
                        style={[styles.chip, isSelected && styles.chipSelected]}
                        onPress={() => togglePlayer(m.player_id)}
                      >
                        <Text style={[styles.chipText, isSelected && styles.chipTextSelected]}>
                          {m.player.display_name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}

              {/* Score entry */}
              {selectedPlayers.size > 0 && (
                <View style={styles.scoresSection}>
                  <View style={styles.scoresHeader}>
                    <Text style={[styles.scoresHeaderText, { flex: 1 }]}>Player</Text>
                    <Text style={[styles.scoresHeaderText, { width: 80 }]}>Game Pts</Text>
                    <Text style={[styles.scoresHeaderText, { width: 60 }]}>+/-</Text>
                  </View>
                  {activeMembers.filter((m) => selectedPlayers.has(m.player_id)).map((m, i) => {
                    const final = getFinal(m.player_id);
                    const isEven = i % 2 === 0;
                    return (
                      <View key={m.player_id} style={[styles.scoreRow, { backgroundColor: isEven ? '#FFF' : '#FAFAFA' }]}>
                        <Text style={styles.scorePlayerName} numberOfLines={1}>{m.player.display_name}</Text>
                        <View>
                          <TextInput
                            style={[styles.scoreInput, scoreErrors[m.player_id] && { borderColor: '#C62828' }]}
                            value={scores[m.player_id] ?? ''}
                            onChangeText={(v) => updateScore(m.player_id, v)}
                            placeholder="Pts"
                            placeholderTextColor="#CCC"
                            keyboardType="numeric"
                          />
                          {scoreErrors[m.player_id] && (
                            <Text style={styles.scoreError}>{scoreErrors[m.player_id]}</Text>
                          )}
                        </View>
                        <Text style={[
                          styles.scoreFinal,
                          final !== null && { color: final >= 0 ? '#2E7D32' : '#C62828' },
                        ]}>
                          {final !== null ? (final >= 0 ? `+${Math.round(final)}` : `${Math.round(final)}`) : '—'}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              )}

              {/* Pool total for tournament */}
              {tournament && buyInNum > 0 && selectedPlayers.size > 0 && (
                <View style={styles.poolRow}>
                  <Text style={[styles.poolText, { color: poolBalanced ? '#2E7D32' : '#C62828' }]}>
                    Total: {Math.round(scoresTotal)} / {Math.round(pool)} {poolBalanced ? '\u2713' : ''}
                  </Text>
                  {!poolBalanced && allScoresFilled && (
                    <Text style={styles.poolError}>
                      Game points must total {Math.round(pool)} pts ({N} players × {buyInNum} buy-in)
                    </Text>
                  )}
                </View>
              )}

              {/* Error / Success */}
              {error && <Text style={styles.errorText}>{error}</Text>}
              {success && <Text style={styles.successText}>Round added!</Text>}
            </ScrollView>

            {/* Footer */}
            <View style={styles.footer}>
              <Pressable style={styles.cancelBtn} onPress={onClose}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.submitBtn, !isValid && styles.submitBtnDisabled]}
                onPress={handleSubmit}
                disabled={!isValid || submitting}
              >
                <Text style={styles.submitBtnText}>
                  {submitting ? 'Submitting...' : tournament ? 'Submit Tournament' : 'Submit Round'}
                </Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheetWrap: { maxHeight: '92%' },
  sheet: {
    backgroundColor: '#FFF', borderTopLeftRadius: 16, borderTopRightRadius: 16,
    paddingHorizontal: 20, paddingTop: 16, maxHeight: '100%',
  },
  scrollBody: { flexShrink: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 20, fontWeight: '700', color: '#1A1A1A' },
  closeBtn: { fontSize: 20, color: '#8E8E93', padding: 4 },

  fieldRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, marginBottom: 6 },
  fieldLabel: { fontSize: 15, fontWeight: '600', color: '#1A1A1A' },
  fieldRequired: { fontSize: 12, color: '#8E8E93' },

  input: {
    borderWidth: 1, borderColor: '#DDD', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: '#1A1A1A',
    backgroundColor: '#FAFAFA',
  },
  datePreview: { fontSize: 12, color: OLIVE, fontWeight: '600', marginTop: 4, marginLeft: 2 },

  seasonBadge: {
    alignSelf: 'flex-start', backgroundColor: '#F0F4E8',
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, marginTop: 12,
  },
  seasonBadgeText: { fontSize: 13, fontWeight: '600', color: OLIVE },

  toggleRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 16, paddingVertical: 8,
  },
  toggleLabel: { fontSize: 15, fontWeight: '500', color: '#1A1A1A' },

  buyInRow: { marginTop: 8 },
  buyInInput: { width: 120 },

  chipContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
    borderWidth: 1.5, borderColor: '#CCC', backgroundColor: '#FFF',
  },
  chipSelected: { backgroundColor: OLIVE, borderColor: OLIVE },
  chipText: { fontSize: 14, fontWeight: '600', color: '#666' },
  chipTextSelected: { color: '#FFF' },

  scoresSection: { marginTop: 20 },
  scoresHeader: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 6,
    borderBottomWidth: 1, borderBottomColor: '#E0E0E0',
  },
  scoresHeaderText: { fontSize: 11, fontWeight: '700', color: '#8E8E93', textTransform: 'uppercase' },
  scoreRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  scorePlayerName: { flex: 1, fontSize: 15, fontWeight: '500', color: '#1A1A1A' },
  scoreInput: {
    width: 80, borderWidth: 1, borderColor: '#DDD', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 8, fontSize: 16, textAlign: 'center',
    backgroundColor: '#FFF', color: '#1A1A1A',
  },
  scoreFinal: { width: 60, textAlign: 'center', fontSize: 15, fontWeight: '600', color: '#999' },
  scoreError: { fontSize: 10, color: '#C62828', marginTop: 2, textAlign: 'center' },
  poolRow: { marginTop: 12, paddingHorizontal: 4 },
  poolText: { fontSize: 15, fontWeight: '700' },
  poolError: { fontSize: 12, color: '#C62828', marginTop: 4 },

  errorText: { color: '#C62828', fontSize: 14, marginTop: 12 },
  successText: { color: '#2E7D32', fontSize: 14, fontWeight: '600', marginTop: 12 },

  footer: {
    flexDirection: 'row', gap: 12, marginTop: 16, paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E0E0E0',
  },
  cancelBtn: {
    flex: 1, paddingVertical: 14, borderRadius: 10, borderWidth: 1.5, borderColor: '#CCC',
    alignItems: 'center',
  },
  cancelBtnText: { fontSize: 16, fontWeight: '600', color: '#666' },
  submitBtn: {
    flex: 1, paddingVertical: 14, borderRadius: 10, backgroundColor: OLIVE,
    alignItems: 'center',
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitBtnText: { fontSize: 16, fontWeight: '600', color: '#FFF' },
});
