import { useCallback, useEffect, useMemo, useState } from 'react';
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

import {
  ApiError,
  generateBroadcastNotes,
  getStandings,
  listGroupMembers,
  listSeasons,
  type BroadcastNotesResponse,
  type MemberWithPlayer,
} from '@/lib/api';
import { useSafeBack } from '@/lib/useSafeBack';

const OLIVE = '#4B5E2A';

export default function BroadcastNotesScreen() {
  const { group_id, group_name } = useLocalSearchParams<{ group_id: string; group_name?: string }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const goBack = useSafeBack();

  const [members, setMembers] = useState<MemberWithPlayer[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<BroadcastNotesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load active, non-retired members; sort by current-season standings rank
  // if available, else by display_name.
  useEffect(() => {
    if (!group_id) return;
    let cancelled = false;
    setLoadingMembers(true);
    (async () => {
      try {
        const all = await listGroupMembers(group_id);
        const active = all.filter((m) => m.is_active === 1 && m.player.retired_at == null);

        let rankByPlayer = new Map<string, number>();
        try {
          const seasons = await listSeasons(group_id);
          const current = [...seasons].sort((a, b) =>
            (b.start_date ?? '').localeCompare(a.start_date ?? '')
          )[0];
          if (current) {
            const standings = await getStandings(current.id, group_id);
            rankByPlayer = new Map(
              standings.map((s) => [s.player_id, s.rank ?? Number.MAX_SAFE_INTEGER])
            );
          }
        } catch {
          // standings unavailable — fall back to name sort below
        }

        active.sort((a, b) => {
          const ra = rankByPlayer.get(a.player_id);
          const rb = rankByPlayer.get(b.player_id);
          if (ra != null && rb != null && ra !== rb) return ra - rb;
          if (ra != null && rb == null) return -1;
          if (ra == null && rb != null) return 1;
          return a.player.display_name.localeCompare(b.player.display_name);
        });

        if (!cancelled) setMembers(active);
      } catch {
        if (!cancelled) setMembers([]);
      } finally {
        if (!cancelled) setLoadingMembers(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [group_id]);

  const toggle = (playerId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
  };

  const count = selected.size;
  const canGenerate = count >= 2 && count <= 6 && !generating;

  const handleGenerate = useCallback(async () => {
    if (!group_id || count < 2 || count > 6) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await generateBroadcastNotes(group_id, [...selected]);
      setResult(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to generate broadcast notes');
    } finally {
      setGenerating(false);
    }
  }, [group_id, selected, count]);

  const selectedNames = useMemo(
    () =>
      members
        .filter((m) => selected.has(m.player_id))
        .map((m) => m.player.display_name),
    [members, selected]
  );

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <View style={styles.headerRow}>
          <Pressable onPress={goBack} hitSlop={8} style={styles.backButton}>
            <Text style={styles.backArrow}>{'‹'}</Text>
          </Pressable>
          <View style={styles.headerTitleWrap}>
            <Text style={styles.headerTitle} numberOfLines={1}>Broadcast Notes</Text>
            {group_name ? (
              <Text style={styles.headerSubtitle} numberOfLines={1}>{group_name}</Text>
            ) : null}
          </View>
          <View style={styles.backButton} />
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
        showsVerticalScrollIndicator
        keyboardShouldPersistTaps="handled">

        <Text style={styles.instruction}>
          Select 2–6 players to feature in the broadcast notes.
        </Text>

        {loadingMembers ? (
          <ActivityIndicator style={{ marginVertical: 20 }} color={OLIVE} />
        ) : members.length === 0 ? (
          <Text style={styles.muted}>No active members in this group.</Text>
        ) : (
          <View style={styles.chipContainer}>
            {members.map((m) => {
              const isSel = selected.has(m.player_id);
              return (
                <Pressable
                  key={m.player_id}
                  style={[styles.chip, isSel && styles.chipSelected]}
                  onPress={() => toggle(m.player_id)}>
                  <Text style={[styles.chipText, isSel && styles.chipTextSelected]}>
                    {m.player.display_name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}

        <Text style={styles.countHint}>
          {count} selected{count < 2 ? ' — pick at least 2' : count > 6 ? ' — max 6' : ''}
        </Text>

        <Pressable
          style={[styles.generateBtn, !canGenerate && styles.generateBtnDisabled]}
          onPress={handleGenerate}
          disabled={!canGenerate}>
          <Text style={styles.generateBtnText}>
            {generating ? 'Generating…' : 'Generate'}
          </Text>
        </Pressable>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {generating ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator color={OLIVE} />
            <Text style={styles.muted}>Generating broadcast notes…</Text>
          </View>
        ) : result ? (
          <View style={styles.outputCard}>
            <Text style={styles.outputMeta}>
              Generated for {result.spotlight_names.join(', ')} · just now
            </Text>
            <Text style={styles.outputText} selectable>
              {result.notes}
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F5F5F5' },
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
  headerSubtitle: { fontSize: 12, color: '#E8EEDD', textAlign: 'center', marginTop: 1 },

  scroll: { flex: 1 },
  instruction: { fontSize: 15, color: '#1A1A1A', marginBottom: 12 },
  muted: { fontSize: 13, color: '#8E8E93' },

  // Chip styles mirror components/AddRoundModal.tsx exactly.
  chipContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: '#CCC',
    backgroundColor: '#FFF',
  },
  chipSelected: { backgroundColor: OLIVE, borderColor: OLIVE },
  chipText: { fontSize: 14, fontWeight: '600', color: '#666' },
  chipTextSelected: { color: '#FFF' },

  countHint: { fontSize: 12, color: '#8E8E93', marginTop: 12, marginBottom: 8 },

  // Primary action button mirrors AddRoundModal submitBtn / disabled pattern.
  generateBtn: {
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: OLIVE,
    alignItems: 'center',
  },
  generateBtnDisabled: { opacity: 0.4 },
  generateBtnText: { fontSize: 16, fontWeight: '600', color: '#FFF' },

  errorText: { color: '#C62828', fontSize: 14, marginTop: 12 },

  loadingBox: { alignItems: 'center', gap: 8, marginTop: 24 },

  outputCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E0E0E0',
    padding: 16,
    marginTop: 20,
  },
  outputMeta: {
    fontSize: 12,
    fontWeight: '600',
    color: OLIVE,
    marginBottom: 12,
  },
  outputText: {
    fontSize: 15,
    color: '#1A1A1A',
    lineHeight: 23,
  },
});
