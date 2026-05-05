import { FlatList, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useGroup } from '@/contexts/GroupContext';
import type { Group } from '@/lib/api';

const OLIVE = '#4B5E2A';

type GroupWithSection = Group & { sectionName?: string };

export function GroupSelectorButton() {
  const { selectedGroup } = useGroup();
  // This is just the tappable header area — the parent wraps it in a Pressable
  return (
    <View style={styles.selectorBtn}>
      {selectedGroup?.logo_url ? (
        <Image source={{ uri: selectedGroup.logo_url }} style={styles.miniLogo} />
      ) : null}
      <Text style={styles.selectorText} numberOfLines={1}>
        {selectedGroup?.name ?? 'Select Group'}
      </Text>
      <Text style={styles.chevron}>{'\u25BE'}</Text>
    </View>
  );
}

export function GroupSelectorModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { groups, selectedGroup, selectGroup, seasons, selectedSeason, selectSeason, seasonLabel } = useGroup();

  const handleSelect = (g: GroupWithSection) => {
    selectGroup(g);
    onClose();
  };

  // Group by section
  type SectionGroup = { title: string; data: GroupWithSection[] };
  const sectionMap = new Map<string, GroupWithSection[]>();
  for (const g of groups) {
    const key = g.sectionName ?? 'Other';
    const list = sectionMap.get(key) ?? [];
    list.push(g);
    sectionMap.set(key, list);
  }
  const sectionGroups: SectionGroup[] = Array.from(sectionMap.entries())
    .map(([title, data]) => ({ title, data }))
    .sort((a, b) => a.title.localeCompare(b.title));

  const getInitials = (name: string) => {
    const parts = name.trim().split(/\s+/);
    return parts.length >= 2
      ? (parts[0][0] + parts[1][0]).toUpperCase()
      : name.slice(0, 2).toUpperCase();
  };

  const flatData: (SectionGroup | GroupWithSection)[] = [];
  for (const section of sectionGroups) {
    flatData.push(section);
    for (const g of section.data) flatData.push(g);
  }

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={styles.modalWrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Select Group</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.modalClose}>{'\u2715'}</Text>
            </Pressable>
          </View>

          <FlatList
            data={flatData}
            keyExtractor={(item, i) => 'title' in item && 'data' in item ? `s-${(item as SectionGroup).title}` : `g-${(item as GroupWithSection).id}`}
            renderItem={({ item }) => {
              if ('title' in item && 'data' in item) {
                const section = item as SectionGroup;
                return (
                  <Text style={styles.sectionHeader}>{section.title}</Text>
                );
              }
              const g = item as GroupWithSection;
              const isSelected = selectedGroup?.id === g.id;
              return (
                <Pressable
                  style={[styles.groupRow, isSelected && styles.groupRowSelected]}
                  onPress={() => handleSelect(g)}
                >
                  {g.logo_url ? (
                    <Image source={{ uri: g.logo_url }} style={styles.groupLogo} />
                  ) : (
                    <View style={styles.groupLogoPlaceholder}>
                      <Text style={styles.groupLogoInitials}>{getInitials(g.name)}</Text>
                    </View>
                  )}
                  <View style={styles.groupInfo}>
                    <Text style={[styles.groupName, isSelected && { color: OLIVE }]} numberOfLines={1}>
                      {g.name}
                    </Text>
                    {g.sectionName ? (
                      <Text style={styles.groupSection}>{g.sectionName}</Text>
                    ) : null}
                  </View>
                  {isSelected ? (
                    <Text style={styles.checkmark}>{'\u2713'}</Text>
                  ) : null}
                </Pressable>
              );
            }}
            showsVerticalScrollIndicator={false}
          />

          {/* Season selector */}
          {seasons.length > 0 && (
            <View style={styles.seasonSection}>
              <Text style={styles.seasonLabel}>Season</Text>
              <FlatList
                data={seasons.sort((a, b) => b.start_date.localeCompare(a.start_date))}
                horizontal
                keyExtractor={(s) => s.id}
                showsHorizontalScrollIndicator={false}
                renderItem={({ item }) => {
                  const isSel = selectedSeason?.id === item.id;
                  return (
                    <Pressable
                      style={[styles.seasonPill, isSel && styles.seasonPillActive]}
                      onPress={() => { selectSeason(item); onClose(); }}
                    >
                      <Text style={[styles.seasonPillText, isSel && styles.seasonPillTextActive]}>
                        {seasonLabel(item)}
                      </Text>
                    </Pressable>
                  );
                }}
                contentContainerStyle={{ gap: 8, paddingVertical: 4 }}
              />
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  selectorBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  miniLogo: {
    width: 24,
    height: 24,
    borderRadius: 4,
    backgroundColor: '#E0E0E0',
  },
  selectorText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '600',
    maxWidth: 180,
  },
  chevron: {
    color: '#FFFFFF',
    fontSize: 14,
    opacity: 0.8,
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
    maxHeight: '80%',
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
    marginTop: 16,
    marginBottom: 6,
    marginLeft: 4,
  },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 10,
    marginBottom: 2,
  },
  groupRowSelected: {
    backgroundColor: '#F0F4E8',
  },
  groupLogo: {
    width: 40,
    height: 40,
    borderRadius: 8,
    marginRight: 12,
    backgroundColor: '#F0F0F0',
  },
  groupLogoPlaceholder: {
    width: 40,
    height: 40,
    borderRadius: 8,
    marginRight: 12,
    backgroundColor: '#E0E0E0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  groupLogoInitials: {
    fontSize: 15,
    fontWeight: '700',
    color: '#8E8E93',
  },
  groupInfo: {
    flex: 1,
  },
  groupName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1A1A1A',
  },
  groupSection: {
    fontSize: 13,
    color: '#8E8E93',
    marginTop: 1,
  },
  checkmark: {
    fontSize: 18,
    color: OLIVE,
    fontWeight: '700',
    marginLeft: 8,
  },

  seasonSection: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E0E0E0',
    paddingTop: 12,
    marginTop: 8,
  },
  seasonLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#8E8E93',
    marginBottom: 8,
  },
  seasonPill: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#F0F0F0',
  },
  seasonPillActive: {
    backgroundColor: OLIVE,
  },
  seasonPillText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
  },
  seasonPillTextActive: {
    color: '#FFFFFF',
  },
});
