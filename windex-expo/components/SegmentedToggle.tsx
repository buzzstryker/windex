import { Pressable, StyleSheet, Text, View } from 'react-native';

const OLIVE = '#4B5E2A';

export type SegmentedOption<K extends string> = { key: K; label: string; disabled?: boolean };

type Props<K extends string> = {
  options: SegmentedOption<K>[];
  value: K;
  onChange: (key: K) => void;
};

/**
 * The olive segmented control: Leaderboard / History on Standings, and the History
 * chart's Season / 10 days / 4 days. One component, so the two cannot drift apart.
 *
 * Styles and style-array order are lifted verbatim from standings.tsx as of commit
 * 979b345, and the Standings toggle must render identically to that commit —
 * scripts/history-chart/verify.js V14 compares them.
 *
 * KNOWN BUG, REPRODUCED ON PURPOSE. See BACKLOG.md, "Standings: switching to All
 * Time on the History tab leaves History selected". That state makes an option
 * active AND disabled at once, and because the arrays below apply active before
 * disabled it renders with the active olive fill under disabled grey text. It is
 * wrong, but it is exactly what Standings rendered before this component existed.
 * Fix the state in standings.tsx per the ticket. Do NOT reorder these arrays or
 * special-case active+disabled here: that changes the rendering V14 pins, and V14
 * will fail.
 */
export function SegmentedToggle<K extends string>({ options, value, onChange }: Props<K>) {
  return (
    <View style={styles.toggleWrap}>
      {options.map((option) => {
        const active = option.key === value;
        return (
          <Pressable
            key={option.key}
            style={[styles.togglePill, active && styles.togglePillActive, option.disabled && styles.togglePillDisabled]}
            onPress={() => { if (!option.disabled) onChange(option.key); }}
            disabled={option.disabled}
          >
            <Text style={[styles.toggleText, active && styles.toggleTextActive, option.disabled && styles.toggleTextDisabled]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  toggleWrap: {
    flexDirection: 'row',
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: OLIVE,
    overflow: 'hidden',
  },
  togglePill: {
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  togglePillActive: {
    backgroundColor: OLIVE,
  },
  togglePillDisabled: {
    opacity: 0.35,
  },
  toggleText: {
    fontSize: 13,
    fontWeight: '600',
    color: OLIVE,
  },
  toggleTextActive: {
    color: '#FFFFFF',
  },
  toggleTextDisabled: {
    color: '#999',
  },
});
