import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { FlatList, Image, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useGroup } from '@/contexts/GroupContext';
import type { Group } from '@/lib/api';

const OLIVE = '#4B5E2A';

type GroupWithSection = Group & { sectionName?: string };

type DrawerProps = {
  visible: boolean;
  onClose: () => void;
  onNavigate: (route: string) => void;
  userName?: string;
  userEmail?: string;
};

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : name.slice(0, 2).toUpperCase();
}

export function Drawer({ visible, onClose, onNavigate, userName, userEmail }: DrawerProps) {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { groups, selectedGroup, selectGroup, myPlayerIds } = useGroup();

  const sheetBg = colorScheme === 'dark' ? colors.card : '#FFFFFF';
  const textColor = colors.text;
  const mutedColor = colors.icon;

  // Split groups into My Groups (member) and Other Groups
  // A group is "mine" if any of my player IDs appear in that group's members
  // Since we don't have membership per group here, use a simpler heuristic:
  // check if the group has data associated with the current user.
  // For now, all groups are visible since the user owns all data.
  // We'll mark groups where the user has a group_member entry.
  // The GroupContext already fetches adminGroupIds — let's use groups list directly.
  // My groups = groups where myPlayerIds has a member (we need to fetch this).
  // Simplification: show all groups as "My Groups" for now since the logged-in user
  // created all groups. We can refine later with actual membership lookup.
  const myGroups = groups; // All groups are accessible
  const otherGroups: GroupWithSection[] = []; // None for now

  const handleGroupSelect = (g: GroupWithSection) => {
    selectGroup(g);
    onClose();
  };

  const renderGroupRow = (g: GroupWithSection, isSelected: boolean) => (
    <Pressable
      key={g.id}
      style={[styles.groupRow, isSelected && styles.groupRowSelected]}
      onPress={() => handleGroupSelect(g)}
    >
      {g.logo_url ? (
        <Image source={{ uri: g.logo_url }} style={styles.groupLogo} />
      ) : (
        <View style={styles.groupLogoPlaceholder}>
          <Text style={styles.groupLogoInitials}>{getInitials(g.name)}</Text>
        </View>
      )}
      <Text style={[styles.groupName, { color: textColor }]} numberOfLines={1}>{g.name}</Text>
      {isSelected && <Text style={styles.checkmark}>{'\u2713'}</Text>}
    </Pressable>
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      statusBarTranslucent>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />

        <View style={[styles.sheet, { backgroundColor: sheetBg, paddingTop: insets.top + 12 }]}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Image source={require('@/assets/images/icon.png')} style={styles.appIcon} />
              <Text style={[styles.appTitle, { color: textColor }]}>Windex</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <MaterialIcons name="close" size={24} color={mutedColor} />
            </TouchableOpacity>
          </View>

          <View style={[styles.separator, { backgroundColor: colors.border }]} />

          {/* Scrollable content */}
          <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
            {/* My Groups */}
            <Text style={[styles.sectionTitle, { color: mutedColor }]}>MY GROUPS</Text>
            {myGroups.map((g) => renderGroupRow(g, selectedGroup?.id === g.id))}

            {/* Other Groups */}
            {otherGroups.length > 0 && (
              <>
                <View style={[styles.separator, { backgroundColor: colors.border, marginVertical: 12 }]} />
                <Text style={[styles.sectionTitle, { color: mutedColor }]}>OTHER GROUPS</Text>
                {otherGroups.map((g) => renderGroupRow(g, selectedGroup?.id === g.id))}
              </>
            )}

            <View style={[styles.separator, { backgroundColor: colors.border, marginVertical: 12 }]} />

            {/* Menu items */}
            <TouchableOpacity style={styles.menuItem} onPress={() => onNavigate('groups')} activeOpacity={0.6}>
              <MaterialIcons name="group" size={22} color={mutedColor} style={styles.menuIcon} />
              <Text style={[styles.menuLabel, { color: textColor }]}>Group Details</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={() => onNavigate('signout')} activeOpacity={0.6}>
              <MaterialIcons name="logout" size={22} color={mutedColor} style={styles.menuIcon} />
              <Text style={[styles.menuLabel, { color: textColor }]}>Sign out</Text>
            </TouchableOpacity>
          </ScrollView>

          {/* User info */}
          <View style={[styles.userSection, { paddingBottom: insets.bottom + 16 }]}>
            <View style={[styles.separator, { backgroundColor: colors.border, marginBottom: 12 }]} />
            <Text style={[styles.userName, { color: textColor }]}>{userName || 'Player'}</Text>
            <Text style={[styles.userEmail, { color: mutedColor }]}>{userEmail || ''}</Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, flexDirection: 'row' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { width: 280, flex: 1, paddingHorizontal: 20 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  headerLeft: { flexDirection: 'row', alignItems: 'center' },
  appIcon: { width: 48, height: 48, borderRadius: 10, marginRight: 12 },
  appTitle: { fontSize: 18, fontWeight: '700' },
  separator: { height: StyleSheet.hairlineWidth, width: '100%' },
  scrollContent: { flex: 1, marginTop: 8 },

  sectionTitle: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8, marginTop: 4 },

  groupRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 4, borderRadius: 8, marginBottom: 2 },
  groupRowSelected: { backgroundColor: '#F0F4E8' },
  groupLogo: { width: 32, height: 32, borderRadius: 6, marginRight: 10, backgroundColor: '#F0F0F0' },
  groupLogoPlaceholder: { width: 32, height: 32, borderRadius: 6, marginRight: 10, backgroundColor: '#E0E0E0', justifyContent: 'center', alignItems: 'center' },
  groupLogoInitials: { fontSize: 12, fontWeight: '700', color: '#8E8E93' },
  groupName: { flex: 1, fontSize: 15, fontWeight: '500' },
  checkmark: { fontSize: 16, color: OLIVE, fontWeight: '700', marginLeft: 8 },

  menuItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  menuIcon: { marginRight: 14 },
  menuLabel: { fontSize: 16, fontWeight: '500' },

  userSection: {},
  userName: { fontSize: 15, fontWeight: '600' },
  userEmail: { fontSize: 13, marginTop: 2 },
});
