import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ScorePill } from '@/components/ScorePill';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import type { EventSummary } from '@/lib/api';
import type { PlayerScore } from '@/lib/roundScores';

function statusEmoji(status: string): string {
  if (status === 'draft') return '✏️';
  return '🔒';
}

function formatRoundDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d
      .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      .toUpperCase();
  } catch {
    return dateStr.toUpperCase();
  }
}

type Props = {
  event: EventSummary;
  scores: PlayerScore[];
  onPress: () => void;
};

export function RoundCard({ event, scores, onPress }: Props) {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? 'light'];
  const muted = colors.icon;

  const emoji = event.is_tournament ? '🏆' : statusEmoji(event.status);
  const dateLabel = formatRoundDate(event.round_date);

  return (
    <Pressable style={[styles.card, { backgroundColor: colors.card }]} onPress={onPress}>
      <View style={styles.cardHeader}>
        <View style={styles.cardDateRow}>
          <Text style={styles.cardEmoji}>{emoji}</Text>
          <View>
            <Text style={[styles.cardDate, { color: colors.tint }]}>{dateLabel}</Text>
            {event.is_tournament ? (
              <Text style={styles.buyinLabel}>{event.tournament_buyin ?? 0} pt buy-in</Text>
            ) : null}
          </View>
          {event.is_signature_event ? (
            <Text style={styles.sigStar}>{'★'}</Text>
          ) : null}
        </View>
        <Pressable hitSlop={8}>
          <Text style={[styles.cardMenu, { color: muted }]}>{'…'}</Text>
        </Pressable>
      </View>

      {scores.length > 0 ? (
        <View style={styles.pillRow}>
          {scores.map((s) => (
            <ScorePill key={s.player_id} name={s.player_name} points={s.points} />
          ))}
        </View>
      ) : (
        <Text style={[styles.cardHint, { color: muted }]}>Tap to view</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12, padding: 14, marginBottom: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08, shadowRadius: 4, elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 8,
  },
  cardDateRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardEmoji: { fontSize: 14 },
  cardDate: { fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },
  sigStar: { fontSize: 14, color: '#DAA520' },
  buyinLabel: { fontSize: 11, color: '#8E8E93', marginTop: 1 },
  cardMenu: { fontSize: 20, fontWeight: '700', lineHeight: 20 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  cardHint: { fontSize: 13 },
});
