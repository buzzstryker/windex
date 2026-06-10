import { Tabs } from 'expo-router';
import React, { useEffect } from 'react';
import { Platform } from 'react-native';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { ChatUnreadProvider, useChatUnread } from '@/contexts/ChatUnreadContext';
import { RoundsUnreadProvider, useRoundsUnread } from '@/contexts/RoundsUnreadContext';
import { useColorScheme } from '@/hooks/use-color-scheme';

/** Dot-sized tabBarBadge style shared by the Chat and Rounds unread dots. */
const BADGE_DOT_STYLE = {
  backgroundColor: '#D32F2F',
  minWidth: 10,
  maxWidth: 10,
  height: 10,
  borderRadius: 5,
  top: 2,
} as const;

/**
 * Mirror the unread flags onto the installed-PWA icon badge. Always called
 * with a count (the iOS no-arg "dot" form clears instead of rendering — WebKit
 * bug 254884); cleared via clearAppBadge. On iOS the badge renders only after
 * notification permission is granted (the value is stored either way).
 */
function useAppBadge(chatUnread: boolean, roundsUnread: boolean): void {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof navigator === 'undefined') return;
    if (!('setAppBadge' in navigator)) return;
    const apply = () => {
      const n = (chatUnread ? 1 : 0) + (roundsUnread ? 1 : 0);
      try {
        if (n > 0) void (navigator as Navigator & { setAppBadge: (c: number) => Promise<void> }).setAppBadge(n);
        else void (navigator as Navigator & { clearAppBadge: () => Promise<void> }).clearAppBadge();
      } catch {
        // Badging must never break tab render.
      }
    };
    apply();
    // Re-apply when the drawer's permission affordance reports a fresh grant.
    window.addEventListener('windex-badge-permission-granted', apply);
    return () => window.removeEventListener('windex-badge-permission-granted', apply);
  }, [chatUnread, roundsUnread]);
}

// Pin the tab navigator's default focused tab to Standings. Without this the
// initial tab was left to expo-router's implicit route resolution, which
// adding the Chat screen perturbed — landing users on Chat. The index redirect
// and the post-login replace already point at Standings; this makes the
// navigator itself agree, deterministically.
export const unstable_settings = {
  initialRouteName: 'standings',
};

export default function TabLayout() {
  return (
    <ChatUnreadProvider>
      <RoundsUnreadProvider>
        <TabLayoutInner />
      </RoundsUnreadProvider>
    </ChatUnreadProvider>
  );
}

function TabLayoutInner() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { hasUnread } = useChatUnread();
  const { hasUnreadRounds } = useRoundsUnread();
  useAppBadge(hasUnread, hasUnreadRounds);

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.tabIconSelected,
        tabBarInactiveTintColor: colors.tabIconDefault,
        tabBarStyle: {
          backgroundColor: colorScheme === 'dark' ? colors.card : '#FFFFFF',
          borderTopColor: colors.border,
        },
        headerShown: false,
        tabBarButton: HapticTab,
      }}>
      {/* Visible tabs */}
      <Tabs.Screen
        name="standings"
        options={{
          title: 'Standings',
          tabBarIcon: ({ color }) => <IconSymbol size={24} name="trophy.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="rounds"
        options={{
          title: 'Rounds',
          tabBarIcon: ({ color }) => <IconSymbol size={24} name="paperplane.fill" color={color} />,
          tabBarBadge: hasUnreadRounds ? '' : undefined,
          tabBarBadgeStyle: BADGE_DOT_STYLE,
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: 'Chat',
          tabBarIcon: ({ color }) => <IconSymbol size={24} name="message.fill" color={color} />,
          // Empty-string badge + dot-sized style = plain unread dot.
          tabBarBadge: hasUnread ? '' : undefined,
          tabBarBadgeStyle: BADGE_DOT_STYLE,
        }}
      />

      {/* Hidden tabs — still routable but not shown in the tab bar */}
      <Tabs.Screen name="index" options={{ href: null }} />
      <Tabs.Screen name="explore" options={{ href: null }} />
      <Tabs.Screen name="history" options={{ href: null }} />
      <Tabs.Screen name="payments" options={{ href: null }} />
    </Tabs>
  );
}
