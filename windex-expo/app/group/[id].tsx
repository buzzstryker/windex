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
import { useLocalSearchParams, useRouter } from 'expo-router';

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import {
  ApiError,
  listGroups,
  listSections,
  listSeasons,
  listEvents,
  getStandings,
  getActiveMemberCount,
  seasonLabel,
  type Group,
  type Season,
  type StandingRow,
} from '@/lib/api';

type GroupDetail = Group & {
  logo_url?: string | null;
  banner_url?: string | null;
};

type SeasonInfo = {
  season: Season;
  eventCount: number;
  champion?: { name: string; points: number } | null;
};

export default function GroupDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? 'light'];
  const router = useRouter();

  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [sectionName, setSectionName] = useState<string | null>(null);
  const [activeMemberCount, setActiveMemberCount] = useState<number | null>(null);
  const [seasonInfos, setSeasonInfos] = useState<SeasonInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        // Fetch group info and sections
        const [groups, sections] = await Promise.all([listGroups(), listSections()]);
        const found = groups.find((g) => g.id === id);
        if (!found) {
          if (!cancelled) setError('Group not found');
          return;
        }
        if (!cancelled) {
          setGroup(found as GroupDetail);
          const sec = sections.find((s) => s.id === found.section_id);
          setSectionName(sec?.name ?? null);
        }

        // Fetch seasons and active member count
        const [seasons, memberCount] = await Promise.all([
          listSeasons(id),
          getActiveMemberCount(id),
        ]);
        if (cancelled) return;
        setActiveMemberCount(memberCount);

        // Sort by start_date descending (most recent first)
        const sorted = [...seasons].sort((a, b) =>
          (b.start_date ?? '').localeCompare(a.start_date ?? '')
        );

        // For each season, get event count and champion
        const infos: SeasonInfo[] = [];
        for (const s of sorted) {
          if (cancelled) return;
          let eventCount = 0;
          let champion: { name: string; points: number } | null = null;
          try {
            const events = await listEvents({ group_id: id, season_id: s.id });
            eventCount = events.length;
          } catch {
            // ignore
          }
          try {
            const standings = await getStandings(s.id, id);
            if (standings.length > 0) {
              champion = {
                name: standings[0].player_name ?? standings[0].player_id.slice(0, 8),
                points: standings[0].total_points,
              };
            }
          } catch {
            // ignore
          }
          infos.push({ season: s, eventCount, champion });
        }

        if (!cancelled) setSeasonInfos(infos);
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id]);

  const totalRounds = seasonInfos.reduce((sum, si) => sum + si.eventCount, 0);
  const currentSeason = seasonInfos.length > 0 ? seasonInfos[0] : null;
  const previousSeasons = seasonInfos.slice(1);

  const formatDateRange = (s: Season): string => {
    const start = new Date(s.start_date + 'T00:00:00');
    const end = s.end_date ? new Date(s.end_date + 'T00:00:00') : null;
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
    const startStr = start.toLocaleDateString('en-US', opts);
    const endStr = end ? end.toLocaleDateString('en-US', opts) : 'Present';
    return `${startStr} - ${endStr}`;
  };

  const getEstablished = (): string => {
    if (seasonInfos.length === 0) return 'N/A';
    const oldest = seasonInfos[seasonInfos.length - 1];
    const d = new Date(oldest.season.start_date + 'T00:00:00');
    return d.getFullYear().toString();
  };

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
          <Text style={styles.headerTitle} numberOfLines={1}>
            {group?.name ?? 'Group'}
          </Text>
          <View style={styles.backButton} />
        </View>
      </View>

      {loading ? (
        <ActivityIndicator style={styles.spinner} size="large" color={OLIVE} />
      ) : error ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : group ? (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          showsVerticalScrollIndicator={false}>

          {/* Banner image area */}
          <View style={styles.bannerContainer}>
            {(group as any).banner_url || (group as any).logo_url ? (
              <Image
                source={{ uri: (group as any).banner_url ?? (group as any).logo_url }}
                style={styles.bannerImage}
                resizeMode="cover"
              />
            ) : (
              <View style={styles.bannerPlaceholder}>
                <Text style={styles.bannerPlaceholderText}>{getInitials(group.name)}</Text>
              </View>
            )}
            {/* Logo overlay */}
            <View style={styles.logoOverlay}>
              {(group as any).logo_url ? (
                <Image
                  source={{ uri: (group as any).logo_url }}
                  style={styles.logoImage}
                />
              ) : (
                <View style={styles.logoPlaceholder}>
                  <Text style={styles.logoInitials}>{getInitials(group.name)}</Text>
                </View>
              )}
            </View>
          </View>

          {/* Group name and section */}
          <View style={styles.nameSection}>
            <Text style={styles.groupName}>{group.name}</Text>
            {sectionName ? (
              <Text style={styles.sectionLabel}>{sectionName}</Text>
            ) : null}
          </View>

          {/* Stats grid */}
          <View style={styles.statsGrid}>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{getEstablished()}</Text>
              <Text style={styles.statLabel}>Established</Text>
            </View>
            <Pressable style={styles.statCard} onPress={() => router.push(`/group-members?group_id=${id}&group_name=${encodeURIComponent(group?.name ?? '')}`)}>
              <Text style={[styles.statValue, { color: '#4B5E2A' }]}>{activeMemberCount ?? '--'}</Text>
              <Text style={styles.statLabel}>Active Members</Text>
            </Pressable>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{seasonInfos.length}</Text>
              <Text style={styles.statLabel}>Seasons Played</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{totalRounds}</Text>
              <Text style={styles.statLabel}>Rounds Played</Text>
            </View>
          </View>

          {/* Current Season */}
          {currentSeason ? (
            <View style={styles.sectionContainer}>
              <Text style={styles.sectionTitle}>Current Season</Text>
              <View style={styles.seasonCard}>
                <Text style={styles.seasonName}>
                  {seasonLabel(currentSeason.season)}
                </Text>
                <Text style={styles.seasonDateRange}>
                  {formatDateRange(currentSeason.season)}
                </Text>
                <Text style={styles.seasonRounds}>
                  {currentSeason.eventCount} round{currentSeason.eventCount !== 1 ? 's' : ''} played
                </Text>
              </View>
            </View>
          ) : null}

          {/* Previous Seasons */}
          {previousSeasons.length > 0 ? (
            <View style={styles.sectionContainer}>
              <Text style={styles.sectionTitle}>Previous Seasons</Text>
              {previousSeasons.map((si) => (
                <View key={si.season.id} style={styles.prevSeasonCard}>
                  {si.champion ? (
                    <View style={styles.championRow}>
                      <Text style={styles.championEmoji}>{'\uD83C\uDFC6'}</Text>
                      <Text style={styles.championName}>{si.champion.name}</Text>
                      <Text style={styles.championPts}>{si.champion.points} pts</Text>
                    </View>
                  ) : null}
                  <Text style={styles.prevSeasonName}>
                    {seasonLabel(si.season)}
                  </Text>
                  <Text style={styles.prevSeasonDate}>
                    {formatDateRange(si.season)}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </ScrollView>
      ) : null}
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

  /* Banner */
  bannerContainer: {
    width: '100%',
    height: 180,
    backgroundColor: '#E0E0E0',
    position: 'relative',
  },
  bannerImage: {
    width: '100%',
    height: '100%',
  },
  bannerPlaceholder: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#D0D0D0',
  },
  bannerPlaceholderText: {
    fontSize: 48,
    fontWeight: '700',
    color: '#AAAAAA',
  },
  logoOverlay: {
    position: 'absolute',
    bottom: -30,
    left: 16,
  },
  logoImage: {
    width: 64,
    height: 64,
    borderRadius: 12,
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  logoPlaceholder: {
    width: 64,
    height: 64,
    borderRadius: 12,
    borderWidth: 3,
    borderColor: '#FFFFFF',
    backgroundColor: '#E0E0E0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoInitials: {
    fontSize: 22,
    fontWeight: '700',
    color: '#8E8E93',
  },

  /* Name section */
  nameSection: {
    paddingHorizontal: 16,
    paddingTop: 40,
    paddingBottom: 16,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
  },
  groupName: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1A1A1A',
    marginBottom: 4,
  },
  sectionLabel: {
    fontSize: 14,
    color: '#8E8E93',
  },

  /* Stats grid */
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 12,
    gap: 10,
  },
  statCard: {
    width: '47%',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E0E0E0',
    padding: 16,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 24,
    fontWeight: '700',
    color: OLIVE,
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 12,
    color: '#8E8E93',
    fontWeight: '500',
    textAlign: 'center',
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
  },

  /* Current season card */
  seasonCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E0E0E0',
    padding: 16,
    marginBottom: 8,
  },
  seasonName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1A1A1A',
    marginBottom: 4,
  },
  seasonDateRange: {
    fontSize: 14,
    color: '#8E8E93',
    marginBottom: 4,
  },
  seasonRounds: {
    fontSize: 13,
    color: OLIVE,
    fontWeight: '500',
  },

  /* Previous seasons */
  prevSeasonCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E0E0E0',
    padding: 16,
    marginBottom: 10,
  },
  championRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  championEmoji: {
    fontSize: 18,
    marginRight: 6,
  },
  championName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1A1A1A',
    flex: 1,
  },
  championPts: {
    fontSize: 14,
    fontWeight: '600',
    color: OLIVE,
  },
  prevSeasonName: {
    fontSize: 15,
    fontWeight: '500',
    color: '#1A1A1A',
    marginBottom: 2,
  },
  prevSeasonDate: {
    fontSize: 13,
    color: '#8E8E93',
  },
});
