import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
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

  useEffect(() => {
    if (!ready) return;
    const first = segments[0];
    const onLogin = first === 'login';
    if (!signedIn && !onLogin) {
      router.replace('/login');
    } else if (signedIn && onLogin) {
      router.replace('/(tabs)/standings');
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
