import { useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Colors } from '@/constants/theme';
import { useGroup } from '@/contexts/GroupContext';
import { useColorScheme } from '@/hooks/use-color-scheme';
import type { Group } from '@/lib/api';

const OLIVE = '#4B5E2A';

/**
 * Phone-only viewport breakpoint. Above this width, the picker doesn't render
 * at all (group switching is in the drawer on desktop).
 */
const PHONE_BREAKPOINT_PX = 768;

type GroupWithSection = Group & { sectionName?: string };

/**
 * GroupPicker — phone-only header dropdown for switching among the user's
 * group memberships. Renders nothing on viewports >= 768px.
 *
 * • If the user is a member of one group, renders the name as static text.
 * • If multiple, renders a tappable dropdown opening a modal list.
 * • Selecting updates GroupContext (drawer stays in sync via shared state).
 */
export function GroupPicker() {
  const { width } = useWindowDimensions();
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const insets = useSafeAreaInsets();
  const { myGroups, selectedGroup, selectGroup } = useGroup();
  const [pickerVisible, setPickerVisible] = useState(false);

  // Hide entirely on tablet/desktop viewports.
  if (width >= PHONE_BREAKPOINT_PX) return null;

  // Nothing to show until groups load or if the user has none.
  if (myGroups.length === 0) return null;

  const currentName = selectedGroup?.name ?? myGroups[0].name;

  // Single-membership: static text, no dropdown affordance.
  if (myGroups.length === 1) {
    return (
      <View style={styles.staticWrap}>
        <Text style={[styles.label, { color: colors.text }]} numberOfLines={1}>
          {currentName}
        </Text>
      </View>
    );
  }

  const handleSelect = (g: GroupWithSection) => {
    selectGroup(g);
    setPickerVisible(false);
  };

  return (
    <>
      <Pressable
        style={styles.button}
        onPress={() => setPickerVisible(true)}
        accessibilityRole="button"
        accessibilityLabel={`Select group, current: ${currentName}`}
        hitSlop={8}
      >
        <Text style={[styles.label, { color: colors.text }]} numberOfLines={1}>
          {currentName}
        </Text>
        <Text style={[styles.chevron, { color: colors.text }]}>{'▾'}</Text>
      </Pressable>

      <Modal visible={pickerVisible} animationType="slide" transparent>
        <View style={styles.modalWrap}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPickerVisible(false)} />
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Switch Group</Text>
              <Pressable onPress={() => setPickerVisible(false)} hitSlop={8}>
                <Text style={styles.modalClose}>{'✕'}</Text>
              </Pressable>
            </View>
            <FlatList
              data={myGroups}
              keyExtractor={(g) => g.id}
              renderItem={({ item }) => {
                const isSel = selectedGroup?.id === item.id;
                return (
                  <Pressable
                    style={[styles.row, isSel && styles.rowSelected]}
                    onPress={() => handleSelect(item)}
                  >
                    <Text style={[styles.rowName, isSel && { color: OLIVE }]} numberOfLines={1}>
                      {item.name}
                    </Text>
                    {isSel ? <Text style={styles.checkmark}>{'✓'}</Text> : null}
                  </Pressable>
                );
              }}
              showsVerticalScrollIndicator={false}
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    minHeight: 44, // iOS HIG minimum touch target
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(75, 94, 42, 0.08)',
    gap: 6,
    maxWidth: '100%',
  },
  staticWrap: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  label: {
    fontSize: 17,
    fontWeight: '600',
    flexShrink: 1,
  },
  chevron: {
    fontSize: 12,
    opacity: 0.7,
  },

  modalWrap: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
    maxHeight: '70%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1A1A1A',
  },
  modalClose: {
    fontSize: 20,
    color: '#8E8E93',
    padding: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 10,
    marginBottom: 2,
  },
  rowSelected: {
    backgroundColor: '#F0F4E8',
  },
  rowName: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: '#1A1A1A',
  },
  checkmark: {
    fontSize: 18,
    color: OLIVE,
    fontWeight: '700',
    marginLeft: 8,
  },
});
