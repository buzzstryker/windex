import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import 'react-native-reanimated';

import { Drawer } from '@/components/Drawer';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { DrawerProvider, useDrawer } from '@/contexts/DrawerContext';
import { GroupProvider } from '@/contexts/GroupContext';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { registerServiceWorker } from '@/lib/pwaUpdate';

export const unstable_settings = {
  anchor: '(tabs)',
};

function RootNavigator() {
  const colorScheme = useColorScheme();
  const { ready, signedIn, signOut } = useAuth();
  const { drawerOpen, closeDrawer } = useDrawer();
  const segments = useSegments();
  const router = useRouter();

  // One-time-per-session guard for the "land on Standings" force. Lets us send
  // a signed-in user to Standings on cold open / reload (even if a PWA resumed
  // on a stale route like /chat) WITHOUT hijacking subsequent in-session
  // navigation — once they've landed, they can move to Chat and stay there.
  const didInitialLanding = useRef(false);

  useEffect(() => {
    if (!ready) return;
    const first = segments[0];
    const onLogin = first === 'login';

    if (!signedIn) {
      // Re-arm the one-time landing so the next signed-in session forces it again.
      didInitialLanding.current = false;
      if (!onLogin) router.replace('/login');
      return;
    }

    // Just authenticated on the login screen → land on Standings.
    if (onLogin) {
      didInitialLanding.current = true;
      router.replace('/(tabs)/standings');
      return;
    }

    // First settled render of the signed-in app (cold open or reload): force
    // Standings once. After this, in-session navigation is left untouched.
    if (!didInitialLanding.current) {
      didInitialLanding.current = true;
      const onStandings = first === '(tabs)' && segments[1] === 'standings';
      if (!onStandings) router.replace('/(tabs)/standings');
    }
  }, [ready, signedIn, segments, router]);

  if (!ready) {
    return (
      <View style={[styles.boot, { backgroundColor: colorScheme === 'dark' ? '#151718' : '#fff' }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  const handleDrawerNavigate = async (route: string) => {
    closeDrawer();
    if (route === 'signout') {
      await signOut();
    } else if (route === 'groups') {
      router.push('/groups');
    } else if (route === 'activity') {
      router.push('/activity');
    }
  };

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="round/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="player/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="groups" options={{ headerShown: false }} />
        <Stack.Screen name="group/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="group-members" options={{ headerShown: false }} />
        <Stack.Screen name="broadcast-notes" options={{ headerShown: false }} />
        <Stack.Screen name="metrics" options={{ headerShown: false }} />
        <Stack.Screen name="activity/index" options={{ headerShown: false }} />
        <Stack.Screen name="activity/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
      </Stack>
      <Drawer
        visible={drawerOpen}
        onClose={closeDrawer}
        onNavigate={handleDrawerNavigate}
      />
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}

export default function RootLayout() {
  // auto-update test 2026-06-01
  // Register the PWA service worker (web only) so installed apps auto-update
  // to new deploys. BUILD_ID (the deploy SHA) makes each deploy's SW script
  // URL unique, which is what triggers the browser to pick up the update.
  useEffect(() => {
    registerServiceWorker((process.env.EXPO_PUBLIC_BUILD_ID ?? '') || 'dev');
  }, []);

  return (
    <AuthProvider>
      <DrawerProvider>
        <GroupProvider>
          <RootNavigator />
        </GroupProvider>
      </DrawerProvider>
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, justifyContent: 'center', alignItems: 'center' },
});
