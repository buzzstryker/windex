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
 * Phone-only viewport breakpoint. Above this width, the picker collapses
 * to just the tab name (group switching is in the drawer on desktop).
 */
const PHONE_BREAKPOINT_PX = 768;

type GroupWithSection = Group & { sectionName?: string };

type Props = {
  /** Tab name shown to the left of the picker affordance (e.g. "Standings"). */
  tabName: string;
};

/**
 * GroupPicker — the centered title on the Standings/Rounds/Analysis tab
 * headers. Always renders the tab name; on phone viewports it appends the
 * selected group with a dropdown chevron (or a separator for single-group
 * users). Designed to live inside `<Header title={…} />`.
 *
 * Tap target: the entire combined unit (tab name + chevron + group name) is
 * pressable on phone multi-group, not just the chevron — easier to hit and
 * matches typical dropdown UX.
 */
export function GroupPicker({ tabName }: Props) {
  const { width } = useWindowDimensions();
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const headerText = colors.headerText;
  const insets = useSafeAreaInsets();
  const { groups, myGroups, selectedGroup, selectGroup } = useGroup();
  const [pickerVisible, setPickerVisible] = useState(false);

  const isPhone = width < PHONE_BREAKPOINT_PX;

  // Desktop, or no groups loaded yet — render just the tab name centered.
  if (!isPhone || groups.length === 0) {
    return (
      <Text style={[styles.tabName, { color: headerText }]} numberOfLines={1}>
        {tabName}
      </Text>
    );
  }

  const groupName = selectedGroup?.name ?? groups[0]?.name ?? '';

  // Only one group exists org-wide — render "Tab · Group" as static text, no
  // affordance (there's nothing to switch to).
  if (groups.length === 1) {
    return (
      <View style={styles.row}>
        <Text style={[styles.tabName, { color: headerText }]} numberOfLines={1}>
          {tabName}
        </Text>
        <Text style={[styles.separator, { color: headerText }]}>·</Text>
        <Text
          style={[styles.groupName, { color: headerText }]}
          numberOfLines={1}
        >
          {groupName}
        </Text>
      </View>
    );
  }

  const handleSelect = (g: GroupWithSection) => {
    selectGroup(g);
    setPickerVisible(false);
  };

  // Build a sectioned list: "My Groups" (active memberships) then "Other
  // Groups" (every other group — viewable but not a membership). Mirrors the
  // Drawer's split. A non-member sees only "Other Groups".
  const myGroupIds = new Set(myGroups.map((g) => g.id));
  const otherGroups = groups
    .filter((g) => !myGroupIds.has(g.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  type PickerRow =
    | { kind: 'header'; title: string }
    | { kind: 'group'; group: GroupWithSection };
  const rows: PickerRow[] = [];
  if (myGroups.length > 0) {
    rows.push({ kind: 'header', title: 'My Groups' });
    for (const g of myGroups) rows.push({ kind: 'group', group: g });
  }
  if (otherGroups.length > 0) {
    rows.push({ kind: 'header', title: 'Other Groups' });
    for (const g of otherGroups) rows.push({ kind: 'group', group: g });
  }

  // More than one group to view — full pressable: "Tab ▾ Group".
  return (
    <>
      <Pressable
        style={styles.row}
        onPress={() => setPickerVisible(true)}
        accessibilityRole="button"
        accessibilityLabel={`${tabName}, group ${groupName}. Tap to switch group.`}
        hitSlop={8}
      >
        <Text style={[styles.tabName, { color: headerText }]} numberOfLines={1}>
          {tabName}
        </Text>
        <Text style={[styles.chevron, { color: headerText }]}>{'▾'}</Text>
        <Text
          style={[styles.groupName, { color: headerText }]}
          numberOfLines={1}
        >
          {groupName}
        </Text>
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
              data={rows}
              keyExtractor={(item) =>
                item.kind === 'header' ? `h-${item.title}` : `g-${item.group.id}`
              }
              renderItem={({ item }) => {
                if (item.kind === 'header') {
                  return <Text style={styles.sectionHeader}>{item.title}</Text>;
                }
                const g = item.group;
                const isSel = selectedGroup?.id === g.id;
                return (
                  <Pressable
                    style={[styles.modalRow, isSel && styles.modalRowSelected]}
                    onPress={() => handleSelect(g)}
                  >
                    <Text style={[styles.modalRowName, isSel && { color: OLIVE }]} numberOfLines={1}>
                      {g.name}
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
  // Pressable / static row inside the Header's centered title slot.
  // alignSelf:'center' + flexShrink keeps it visually centered while still
  // allowing the long-text branch (groupName) to truncate within the slot.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44, // iOS HIG touch target
    paddingHorizontal: 4,
    flexShrink: 1,
    minWidth: 0,
  },
  tabName: {
    fontSize: 17,
    fontWeight: '600',
    flexShrink: 0,
  },
  chevron: {
    fontSize: 13,
    fontWeight: '600',
    opacity: 0.8,
    marginHorizontal: 4,
    flexShrink: 0,
  },
  separator: {
    fontSize: 17,
    fontWeight: '600',
    opacity: 0.6,
    marginHorizontal: 6,
    flexShrink: 0,
  },
  // Subordinated to the tab name with a slight opacity drop. Truncates with
  // ellipsis when the combined unit gets too wide for the centered slot.
  groupName: {
    fontSize: 17,
    fontWeight: '500',
    opacity: 0.85,
    flexShrink: 1,
    minWidth: 0,
  },

  // Modal styling matches the previous picker's bottom-sheet look.
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
  sectionHeader: {
    fontSize: 13,
    fontWeight: '700',
    color: '#8E8E93',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 12,
    marginBottom: 4,
    marginLeft: 8,
  },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 10,
    marginBottom: 2,
  },
  modalRowSelected: {
    backgroundColor: '#F0F4E8',
  },
  modalRowName: {
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
