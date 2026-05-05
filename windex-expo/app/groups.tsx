import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import {
  ApiError,
  listGroups,
  listSections,
  type Group,
  type Section,
} from '@/lib/api';

type GroupExt = Group & {
  logo_url?: string | null;
};

export default function GroupsScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? 'light'];
  const router = useRouter();

  const [groups, setGroups] = useState<GroupExt[]>([]);
  const [sectionNames, setSectionNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadGroups = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [g, s] = await Promise.all([listGroups(), listSections()]);
      setGroups(g as GroupExt[]);
      const nameMap: Record<string, string> = {};
      for (const sec of s) nameMap[sec.id] = sec.name;
      setSectionNames(nameMap);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  // Group by section_id
  const sections = (() => {
    const map = new Map<string, GroupExt[]>();
    for (const g of groups) {
      const sid = g.section_id ?? 'other';
      const list = map.get(sid) ?? [];
      list.push(g);
      map.set(sid, list);
    }
    return Array.from(map.entries()).map(([key, items]) => ({
      title: key === 'other' ? 'Other' : (sectionNames[key] ?? key),
      data: items,
    }));
  })();

  const getInitials = (name: string): string => {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  };

  return (
    <View style={styles.screen}>
      {/* Olive green header */}
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <View style={styles.headerRow}>
          <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backButton}>
            <Text style={styles.backArrow}>{'\u2039'}</Text>
          </Pressable>
          <Text style={styles.headerTitle}>Groups</Text>
          <View style={styles.backButton} />
        </View>
      </View>

      {loading ? (
        <ActivityIndicator style={styles.spinner} size="large" color={OLIVE} />
      ) : error ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : groups.length === 0 ? (
        <Text style={styles.emptyText}>No groups found.</Text>
      ) : (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24, paddingTop: 8 }}
          showsVerticalScrollIndicator={false}>

          {sections.map((section) => (
            <View key={section.title} style={styles.sectionContainer}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              {section.data.map((g) => (
                <Pressable
                  key={g.id}
                  style={styles.groupCard}
                  onPress={() => router.push(`/group/${g.id}`)}>
                  <View style={styles.groupRow}>
                    {g.logo_url ? (
                      <Image source={{ uri: g.logo_url }} style={styles.groupLogo} />
                    ) : (
                      <View style={styles.groupLogoPlaceholder}>
                        <Text style={styles.groupLogoInitials}>{getInitials(g.name)}</Text>
                      </View>
                    )}
                    <Text style={styles.groupName} numberOfLines={1}>{g.name}</Text>
                    <Text style={styles.groupChevron}>{'\u203A'}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const OLIVE = '#4B5E2A';

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  header: {
    backgroundColor: OLIVE,
    width: '100%',
  },
  headerRow: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  backButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backArrow: {
    fontSize: 32,
    color: '#FFFFFF',
    fontWeight: '300',
    lineHeight: 36,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#FFFFFF',
    textAlign: 'center',
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  spinner: {
    marginVertical: 40,
  },
  errorCard: {
    backgroundColor: '#FFEBEE',
    borderRadius: 10,
    padding: 14,
    margin: 16,
  },
  errorText: {
    color: '#C62828',
    fontSize: 14,
  },
  emptyText: {
    textAlign: 'center',
    color: '#8E8E93',
    fontSize: 15,
    marginTop: 40,
  },

  /* Sections */
  sectionContainer: {
    marginHorizontal: 16,
    marginTop: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1A1A1A',
    marginBottom: 10,
    marginLeft: 4,
  },

  /* Group card */
  groupCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E0E0E0',
    marginBottom: 10,
    padding: 14,
  },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  groupLogo: {
    width: 48,
    height: 48,
    borderRadius: 8,
    marginRight: 14,
    backgroundColor: '#F0F0F0',
  },
  groupLogoPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 8,
    marginRight: 14,
    backgroundColor: '#E0E0E0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  groupLogoInitials: {
    fontSize: 18,
    fontWeight: '700',
    color: '#8E8E93',
  },
  groupName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1A1A1A',
    flex: 1,
  },
  groupChevron: {
    fontSize: 22,
    color: '#8E8E93',
    marginLeft: 8,
  },
});
