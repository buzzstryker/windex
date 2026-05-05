import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
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
  computeMoneyDeltas,
  generatePaymentRequests,
  listEvents,
  listGroups,
  listSeasons,
  seasonLabel,
  type EventSummary,
  type Group,
  type Season,
} from '@/lib/api';

type PaymentRequest = {
  from_player_id: string;
  to_player_id: string;
  amount_cents: number;
};

export default function PaymentsScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const muted = Colors[colorScheme ?? 'light'].icon;
  const tint = Colors[colorScheme ?? 'light'].tint;
  const border = colorScheme === 'dark' ? '#444' : '#ddd';

  const [groups, setGroups] = useState<Group[]>([]);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [groupId, setGroupId] = useState<string>('');
  const [seasonId, setSeasonId] = useState<string>('');
  const [roundId, setRoundId] = useState<string>('');

  const [loadingGroups, setLoadingGroups] = useState(true);
  const [loadingSeasons, setLoadingSeasons] = useState(false);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [payments, setPayments] = useState<PaymentRequest[]>([]);

  const [picker, setPicker] = useState<'group' | 'season' | 'round' | null>(null);

  const selectedGroup = groups.find((g) => g.id === groupId);
  const selectedSeason = seasons.find((s) => s.id === seasonId);
  const selectedRound = events.find((e) => e.id === roundId);

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

  // Seasons
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

  // Events (rounds) for group + season
  useEffect(() => {
    if (!seasonId || !groupId) {
      setEvents([]);
      setRoundId('');
      return;
    }
    let cancelled = false;
    setLoadingEvents(true);
    setError(null);
    listEvents({ group_id: groupId, season_id: seasonId })
      .then((evts) => {
        if (!cancelled) {
          setEvents(evts);
          setRoundId('');
          setPayments([]);
          setSuccessMsg(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : String(e));
          setEvents([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingEvents(false);
      });
    return () => {
      cancelled = true;
    };
  }, [seasonId, groupId]);

  const handleComputeDeltas = useCallback(async () => {
    if (!roundId) return;
    setProcessing(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const result = await computeMoneyDeltas(roundId);
      if (result.computed) {
        setSuccessMsg(`Money deltas computed. Updated ${result.updated ?? 0} rows.`);
      } else {
        setSuccessMsg(result.reason ?? 'Money deltas already up to date.');
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setProcessing(false);
    }
  }, [roundId]);

  const handleGeneratePayments = useCallback(async () => {
    if (!roundId) return;
    setProcessing(true);
    setError(null);
    setSuccessMsg(null);
    setPayments([]);
    try {
      const result = await generatePaymentRequests(roundId);
      setPayments(result.requests ?? []);
      setSuccessMsg(
        result.requests?.length
          ? `Generated ${result.requests.length} payment request(s).`
          : 'No payment requests generated.',
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setProcessing(false);
    }
  }, [roundId]);

  const renderPayment = ({ item }: { item: PaymentRequest }) => (
    <View style={[styles.row, { borderBottomColor: border }]}>
      <ThemedText style={styles.fromCol} numberOfLines={1}>
        {item.from_player_id.slice(0, 8)}...
      </ThemedText>
      <ThemedText style={styles.arrowCol}>-&gt;</ThemedText>
      <ThemedText style={styles.toCol} numberOfLines={1}>
        {item.to_player_id.slice(0, 8)}...
      </ThemedText>
      <ThemedText style={styles.amtCol}>
        ${(item.amount_cents / 100).toFixed(2)}
      </ThemedText>
    </View>
  );

  return (
    <ThemedView style={[styles.screen, { paddingTop: insets.top + 12 }]}>
      <ThemedText type="title" style={styles.title}>
        Payments
      </ThemedText>
      <ThemedText style={[styles.sub, { color: muted }]}>
        Compute money deltas and generate payment requests for a round.
      </ThemedText>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
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

          <Pressable
            style={[styles.selectBtn, { borderColor: border }]}
            onPress={() => seasonId && setPicker('round')}
            disabled={!seasonId || loadingEvents}>
            <ThemedText type="defaultSemiBold">Round</ThemedText>
            <ThemedText style={{ color: muted }} numberOfLines={1}>
              {selectedRound
                ? selectedRound.round_date
                : seasonId
                  ? loadingEvents
                    ? 'Loading...'
                    : 'Choose round'
                  : 'Select season first'}
            </ThemedText>
          </Pressable>
        </View>

        {/* Action buttons */}
        {roundId ? (
          <View style={styles.actions}>
            <Pressable
              style={[styles.cta, { backgroundColor: tint }]}
              onPress={handleComputeDeltas}
              disabled={processing}>
              <ThemedText style={styles.ctaText}>
                {processing ? 'Processing...' : 'Compute Money Deltas'}
              </ThemedText>
            </Pressable>

            <Pressable
              style={[styles.cta, { backgroundColor: tint }]}
              onPress={handleGeneratePayments}
              disabled={processing}>
              <ThemedText style={styles.ctaText}>
                {processing ? 'Processing...' : 'Generate Payment Requests'}
              </ThemedText>
            </Pressable>
          </View>
        ) : null}

        {error ? (
          <ThemedText style={styles.errorBanner}>{error}</ThemedText>
        ) : null}

        {successMsg ? (
          <ThemedText style={styles.successBanner}>{successMsg}</ThemedText>
        ) : null}

        {processing ? (
          <ActivityIndicator style={styles.spinner} size="large" />
        ) : null}

        {/* Payment results */}
        {payments.length > 0 ? (
          <>
            <ThemedText type="subtitle" style={styles.sectionTitle}>
              Payment Requests
            </ThemedText>
            <View style={[styles.tableHeader, { borderBottomColor: border }]}>
              <ThemedText style={[styles.fromCol, { color: muted }]}>From</ThemedText>
              <ThemedText style={[styles.arrowCol, { color: muted }]}> </ThemedText>
              <ThemedText style={[styles.toCol, { color: muted }]}>To</ThemedText>
              <ThemedText style={[styles.amtCol, { color: muted }]}>Amount</ThemedText>
            </View>
            {payments.map((p, i) => (
              <View
                key={`${p.from_player_id}-${p.to_player_id}-${i}`}
                style={[styles.row, { borderBottomColor: border }]}>
                <ThemedText style={styles.fromCol} numberOfLines={1}>
                  {p.from_player_id.slice(0, 8)}...
                </ThemedText>
                <ThemedText style={styles.arrowCol}>-&gt;</ThemedText>
                <ThemedText style={styles.toCol} numberOfLines={1}>
                  {p.to_player_id.slice(0, 8)}...
                </ThemedText>
                <ThemedText style={styles.amtCol}>
                  ${(p.amount_cents / 100).toFixed(2)}
                </ThemedText>
              </View>
            ))}
          </>
        ) : null}
      </ScrollView>

      {/* Picker modal */}
      <Modal visible={picker !== null} animationType="slide" transparent>
        <View style={styles.modalWrap}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPicker(null)} />
          <ThemedView style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
            <ThemedText type="subtitle" style={styles.modalTitle}>
              {picker === 'group' ? 'Group' : picker === 'season' ? 'Season' : 'Round'}
            </ThemedText>
            <FlatList
              data={
                picker === 'group'
                  ? groups
                  : picker === 'season'
                    ? seasons
                    : events
              }
              keyExtractor={(item: Group | Season | EventSummary) => item.id}
              renderItem={({ item }) => {
                if (picker === 'group') {
                  const g = item as Group;
                  return (
                    <Pressable
                      style={[styles.modalRow, { borderBottomColor: border }]}
                      onPress={() => {
                        setGroupId(g.id);
                        setSeasonId('');
                        setRoundId('');
                        setPayments([]);
                        setSuccessMsg(null);
                        setPicker(null);
                      }}>
                      <ThemedText>{g.name}</ThemedText>
                    </Pressable>
                  );
                }
                if (picker === 'season') {
                  const s = item as Season;
                  return (
                    <Pressable
                      style={[styles.modalRow, { borderBottomColor: border }]}
                      onPress={() => {
                        setSeasonId(s.id);
                        setRoundId('');
                        setPayments([]);
                        setSuccessMsg(null);
                        setPicker(null);
                      }}>
                      <ThemedText>{seasonLabel(s)}</ThemedText>
                    </Pressable>
                  );
                }
                const e = item as EventSummary;
                return (
                  <Pressable
                    style={[styles.modalRow, { borderBottomColor: border }]}
                    onPress={() => {
                      setRoundId(e.id);
                      setPayments([]);
                      setSuccessMsg(null);
                      setPicker(null);
                    }}>
                    <ThemedText>{e.round_date}</ThemedText>
                    <ThemedText style={{ color: muted, fontSize: 13 }}>
                      {e.status}
                    </ThemedText>
                  </Pressable>
                );
              }}
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
  actions: { gap: 10, marginBottom: 16 },
  cta: {
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  ctaText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  sectionTitle: { marginTop: 16, marginBottom: 8 },
  errorBanner: { color: '#c62828', marginBottom: 8, fontSize: 14 },
  successBanner: { color: '#2e7d32', marginBottom: 8, fontSize: 14 },
  spinner: { marginVertical: 24 },
  tableHeader: {
    flexDirection: 'row',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    paddingVertical: 12,
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  fromCol: { flex: 1 },
  arrowCol: { width: 28, textAlign: 'center' },
  toCol: { flex: 1 },
  amtCol: { width: 70, textAlign: 'right', fontVariant: ['tabular-nums'] },
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
