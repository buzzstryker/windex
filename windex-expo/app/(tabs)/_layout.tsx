import { Tabs } from 'expo-router';
import React from 'react';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { ChatUnreadProvider, useChatUnread } from '@/contexts/ChatUnreadContext';
import { useColorScheme } from '@/hooks/use-color-scheme';

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
      <TabLayoutInner />
    </ChatUnreadProvider>
  );
}

function TabLayoutInner() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { hasUnread } = useChatUnread();

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
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: 'Chat',
          tabBarIcon: ({ color }) => <IconSymbol size={24} name="message.fill" color={color} />,
          // Empty-string badge + dot-sized style = plain unread dot.
          tabBarBadge: hasUnread ? '' : undefined,
          tabBarBadgeStyle: {
            backgroundColor: '#D32F2F',
            minWidth: 10,
            maxWidth: 10,
            height: 10,
            borderRadius: 5,
            top: 2,
          },
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
