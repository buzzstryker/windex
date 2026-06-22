import { Pressable, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import { useColorScheme } from '@/hooks/use-color-scheme';

export default function AboutScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const muted = Colors[colorScheme ?? 'light'].icon;
  const border = colorScheme === 'dark' ? '#444' : '#ccc';
  const { signOut } = useAuth();

  return (
    <ThemedView style={[styles.screen, { paddingTop: insets.top + 24 }]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}>
        <ThemedText type="title" style={styles.title}>
          About
        </ThemedText>
        <ThemedText style={[styles.p, { color: muted }]}>
          <ThemedText type="defaultSemiBold">Windex</ThemedText> aggregates points and
          standings from submitted matches. This iPad app talks to the same backend as your admin
          workflow.
        </ThemedText>
        <ThemedText style={[styles.p, { color: muted }]}>
          More screens (events, player history, etc.) can be added here so you rarely need a desktop
          browser for day-to-day checks.
        </ThemedText>

        <Pressable
          style={[styles.signOut, { borderColor: border }]}
          onPress={() => signOut()}>
          <ThemedText type="defaultSemiBold" style={styles.signOutText}>
            Sign out
          </ThemedText>
        </Pressable>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  scroll: {
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  title: {
    marginBottom: 20,
  },
  p: {
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 16,
  },
  signOut: {
    marginTop: 32,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  signOutText: {
    color: '#c62828',
  },
});
