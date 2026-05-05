import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

type HeaderProps = {
  title: string;
  onMenuPress?: () => void;
};

export function Header({ title, onMenuPress }: HeaderProps) {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.headerBg }]}>
      <View style={styles.row}>
        <TouchableOpacity onPress={onMenuPress} style={styles.menuButton} hitSlop={8}>
          <View style={styles.hamburger}>
            <View style={styles.hamburgerLine} />
            <View style={styles.hamburgerLine} />
            <View style={styles.hamburgerLine} />
          </View>
        </TouchableOpacity>

        <Text style={[styles.title, { color: colors.headerText }]} numberOfLines={1}>
          {title}
        </Text>

        {/* Spacer to keep title centered */}
        <View style={styles.menuButton} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  row: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  menuButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  hamburger: {
    width: 22,
    height: 18,
    justifyContent: 'space-between',
  },
  hamburgerLine: {
    width: 22,
    height: 2.5,
    backgroundColor: '#FFFFFF',
    borderRadius: 1,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
    flex: 1,
  },
});
