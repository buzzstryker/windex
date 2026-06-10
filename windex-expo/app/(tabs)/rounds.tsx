import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';

import { Header } from '@/components/Header';
import { GroupBanner } from '@/components/GroupBanner';
import { GroupPicker } from '@/components/GroupPicker';
// GroupSelector removed — group selection now in hamburger drawer (desktop) or GroupPicker (phone)
import { AddRoundModal } from '@/components/AddRoundModal';
import { RoundCard } from '@/components/RoundCard';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors } from '@/constants/theme';
import { useDrawer } from '@/contexts/DrawerContext';
import { useGroup } from '@/contexts/GroupContext';
import { useRoundsUnread } from '@/contexts/RoundsUnreadContext';
import { useColorScheme } from '@/hooks/use-color-scheme';
import {
  ApiError,
  getStoredAccessToken,
  listEvents,
  type EventSummary,
} from '@/lib/api';
import { getAuthorPlayerId } from '@/lib/chatAuthor';
import { getApiBase, getSupabaseAnonKey } from '@/lib/config';
import { fetchRoundScores, type RoundScores } from '@/lib/roundScores';
import { logUserEvent } from '@/lib/userEvents';

export default function RoundsScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? 'light'];
  const muted = colors.icon;
  const router = useRouter();
  const { openDrawer } = useDrawer();

  const { selectedGroup, selectedGroupIsMine, selectedSeason, seasonLabel, reload, dataVersion, invalidateData, isSelectedSeasonActive, isSuperAdmin, isGroupAdmin, myPlayerIds } = useGroup();
  const { markRoundsSeen } = useRoundsUnread();

  // Record the rounds watermark (upsert on the player_id PK) and clear the
  // tab dot. Mirrors chat.tsx's markRoomRead; failures are non-fatal.
  const markRoundsRead = useCallback(async () => {
    markRoundsSeen();
    const playerId = await getAuthorPlayerId();
    const token = await getStoredAccessToken();
    if (!playerId || !token) return;
    const anonKey = getSupabaseAnonKey();
    const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
    try {
      await fetch(`${base}/rest/v1/rounds_reads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          apikey: anonKey || token,
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({ player_id: playerId, last_seen_at: new Date().toISOString() }),
      });
    } catch {
      /* non-fatal; next focus retries */
    }
  }, [markRoundsSeen]);

  useFocusEffect(
    useCallback(() => {
      void markRoundsRead();
    }, [markRoundsRead])
  );

  // Log view_rounds_list on initial mount and whenever the selected group
  // or season changes. Read myPlayerIds via a ref so the effect doesn't
  // re-fire when the player_id cache resolves a beat after sign-in.
  const myPlayerIdsRef = useRef(myPlayerIds);
  myPlayerIdsRef.current = myPlayerIds;
  useEffect(() => {
    if (selectedGroup && selectedSeason) {
      void logUserEvent('view_rounds_list', {
        groupId: selectedGroup.id,
        seasonId: selectedSeason.id,
        playerId: myPlayerIdsRef.current[0] ?? null,
      });
    }
  }, [selectedGroup?.id, selectedSeason?.id]);

  // Add Round inserts into league_rounds + league_scores, whose INSERT RLS
  // requires am_i_group_member(group_id) — no super-admin/group-admin bypass.
  // So the affordance is hidden entirely when viewing a group the user isn't a
  // member of. For members, the existing rule still applies: active season for
  // everyone, plus past-season backfill for super-admins / group-admins.
  const canAddRound =
    selectedGroupIsMine &&
    (isSelectedSeasonActive || isSuperAdmin || (selectedGroup ? isGroupAdmin(selectedGroup.id) : false));

  const [events, setEvents] = useState<EventSummary[]>([]);
  const [roundScores, setRoundScores] = useState<RoundScores>({});
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // showGroupSelector removed — group selection in drawer
  const [showAddRound, setShowAddRound] = useState(false);

  useEffect(() => {
    if (!selectedGroup) {
      setEvents([]);
      setRoundScores({});
      return;
    }
    let cancelled = false;
    setLoadingEvents(true);
    setError(null);
    const params: { group_id?: string; season_id?: string } = { group_id: selectedGroup.id };
    if (selectedSeason) params.season_id = selectedSeason.id;
    listEvents(params)
      .then(async (ev) => {
        if (cancelled) return;
        // Sort newest first
        ev.sort((a, b) => b.round_date.localeCompare(a.round_date));
        setEvents(ev);
        // Fetch scores for all rounds
        const scores = await fetchRoundScores(ev.map((e) => e.id));
        if (!cancelled) setRoundScores(scores);
      })
      .catch((e) => {
        if (!cancelled) {
          setEvents([]);
          setError(e instanceof ApiError ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingEvents(false);
      });
    return () => { cancelled = true; };
  }, [selectedGroup?.id, selectedSeason?.id, dataVersion]);

  const refreshData = useCallback(async () => {
    await reload();
    if (selectedGroup) {
      setLoadingEvents(true);
      const params: { group_id?: string; season_id?: string } = { group_id: selectedGroup.id };
      if (selectedSeason) params.season_id = selectedSeason.id;
      listEvents(params)
        .then(async (ev) => {
          ev.sort((a, b) => b.round_date.localeCompare(a.round_date));
          setEvents(ev);
          const scores = await fetchRoundScores(ev.map((e) => e.id));
          setRoundScores(scores);
        })
        .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))
        .finally(() => setLoadingEvents(false));
    }
  }, [reload, selectedGroup?.id, selectedSeason?.id]);

  const bannerSeasonLabel = selectedSeason
    ? `${seasonLabel(selectedSeason)} Season`
    : 'Season';

  const renderRoundCard = ({ item }: { item: EventSummary }) => (
    <RoundCard
      event={item}
      scores={roundScores[item.id] ?? []}
      onPress={() => router.push(`/round/${item.id}`)}
    />
  );

  const listHeader = (
    <View style={styles.seasonHeaderRow}>
      <View>
        <Text style={[styles.seasonTitle, { color: colors.text }]}>
          {bannerSeasonLabel}
        </Text>
        {!isSelectedSeasonActive && selectedSeason && (
          <Text style={styles.seasonEndedLabel}>Season ended</Text>
        )}
      </View>
      <View style={styles.seasonActions}>
        {canAddRound && (
          <Pressable style={[styles.addRoundBtn, { backgroundColor: colors.tint }]} onPress={() => setShowAddRound(true)}>
            <Text style={styles.addRoundText}>+ Add Round</Text>
          </Pressable>
        )}
      </View>
    </View>
  );

  return (
    <ThemedView style={styles.screen}>
      <Header title={<GroupPicker tabName="Rounds" />} onMenuPress={openDrawer} />

      <GroupBanner
        imageUrl={selectedGroup?.logo_url ?? null}
        groupName={selectedGroup?.name ?? ''}
        seasonLabel={bannerSeasonLabel}
      />

      {error ? (
        <ThemedText style={styles.errorBanner}>{error}</ThemedText>
      ) : null}

      {loadingEvents ? (
        <ActivityIndicator style={styles.spinner} size="large" />
      ) : null}

      <FlatList
        data={events}
        keyExtractor={(item) => item.id}
        renderItem={renderRoundCard}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={
          !loadingEvents && selectedGroup && !error ? (
            <ThemedText style={[styles.empty, { color: muted }]}>
              No rounds found.
            </ThemedText>
          ) : null
        }
        contentContainerStyle={styles.listContent}
        refreshing={loadingEvents}
        onRefresh={refreshData}
      />

      {/* Group selection is in the hamburger drawer */}

      <AddRoundModal
        visible={showAddRound}
        onClose={() => setShowAddRound(false)}
        onSuccess={() => { invalidateData(); refreshData(); }}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  errorBanner: { color: '#c62828', marginBottom: 8, fontSize: 14, paddingHorizontal: 16 },
  spinner: { marginVertical: 24 },
  empty: { textAlign: 'center', marginTop: 24, fontSize: 15 },
  seasonHeaderRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 0, marginBottom: 12,
  },
  seasonTitle: { fontSize: 24, fontWeight: 'bold' },
  seasonEndedLabel: { fontSize: 12, color: '#8E8E93', marginTop: 2 },
  seasonActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  addRoundBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  addRoundText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  listContent: { paddingHorizontal: 16, paddingBottom: 100 },
});
