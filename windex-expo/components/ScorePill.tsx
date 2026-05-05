import { StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

type ScorePillProps = {
  name: string;
  points: number;
};

export function ScorePill({ name, points }: ScorePillProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  let backgroundColor: string;
  let textColor: string;

  if (points > 0) {
    backgroundColor = colors.pillPositive;
    textColor = colors.positive;
  } else if (points < 0) {
    backgroundColor = colors.pillNegative;
    textColor = colors.negative;
  } else {
    backgroundColor = colorScheme === 'dark' ? '#2C2C2E' : '#EEEEEE';
    textColor = colors.text;
  }

  return (
    <View style={[styles.pill, { backgroundColor }]}>
      <Text style={[styles.text, { color: textColor }]}>
        {name} {points}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    marginRight: 8,
    marginBottom: 6,
  },
  text: {
    fontSize: 13,
    fontWeight: '500',
  },
});
