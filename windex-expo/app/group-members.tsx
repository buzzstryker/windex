import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import {
  listGroupMembers,
  updatePlayerRest,
  updateMembershipRest,
  type MemberWithPlayer,
} from '@/lib/api';

const OLIVE = '#4B5E2A';

function getCurrentUserId(): string | null {
  // Extract from stored JWT — we'll get it from the auth persistence
  try {
    // This is a simplified version; in production use the auth context
    return null;
  } catch {
    return null;
  }
}

export default function GroupMembersScreen() {
  const { group_id, group_name } = useLocalSearchParams<{ group_id: string; group_name?: string }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [members, setMembers] = useState<MemberWithPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editMember, setEditMember] = useState<MemberWithPlayer | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  // Check if current user is admin of this group
  const isAdmin = members.some((m) => m.role === 'admin');
  // For now, treat all users as admin for editing (the dev user owns everything)
  const canEdit = true;

  // Edit form state
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editFullName, setEditFullName] = useState('');
  const [editVenmo, setEditVenmo] = useState('');
  const [editActive, setEditActive] = useState(1);

  const load = useCallback(async () => {
    if (!group_id) return;
    setLoading(true);
    setError(null);
    try {
      const m = await listGroupMembers(group_id);
      setMembers(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [group_id]);

  useEffect(() => { load(); }, [load]);

  const openEdit = (m: MemberWithPlayer) => {
    setEditMember(m);
    setEditDisplayName(m.player.display_name);
    setEditFullName(m.player.full_name ?? '');
    setEditVenmo(m.player.venmo_handle ?? '');
    setEditActive(m.is_active);
    setSaveMsg(null);
  };

  const handleSave = async () => {
    if (!editMember) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      // We need the user_id for the player update. Since we're the data owner,
      // get it from the JWT. For simplicity, we'll try updating and see if RLS allows it.
      const tokenRaw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('late_add_mobile_jwt') : null;
      let userId = '';
      if (tokenRaw) {
        try { userId = JSON.parse(atob(tokenRaw.split('.')[1])).sub; } catch {}
      }
      // Try localStorage too (web auth persistence)
      if (!userId && typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem('late_add_mobile_jwt');
        if (stored) {
          try { userId = JSON.parse(atob(stored.split('.')[1])).sub; } catch {}
        }
        // Also check Supabase session
        if (!userId) {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.includes('supabase') && key.includes('auth')) {
              try {
                const val = JSON.parse(localStorage.getItem(key) ?? '');
                if (val?.access_token) {
                  userId = JSON.parse(atob(val.access_token.split('.')[1])).sub;
                  break;
                }
              } catch {}
            }
          }
        }
      }

      const playerOk = await updatePlayerRest(editMember.player_id, userId, {
        display_name: editDisplayName,
        full_name: editFullName || null,
        venmo_handle: editVenmo || null,
        is_active: editActive,
      });
      const memberOk = await updateMembershipRest(editMember.id, {
        is_active: editActive,
      });
      if (playerOk && memberOk) {
        setSaveMsg('Saved');
        setEditMember(null);
        load();
      } else {
        setSaveMsg('Save failed — check permissions');
      }
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const activeMembers = members.filter((m) => m.is_active === 1);
  const inactiveMembers = members.filter((m) => m.is_active !== 1);

  const renderMember = ({ item }: { item: MemberWithPlayer }) => (
    <Pressable
      style={styles.memberCard}
      onPress={canEdit ? () => openEdit(item) : undefined}
    >
      <View style={styles.memberRow}>
        <View style={styles.memberInfo}>
          <Text style={styles.memberName}>{item.player.display_name}</Text>
          {item.player.full_name ? (
            <Text style={styles.memberDetail}>{item.player.full_name}</Text>
          ) : null}
          {item.player.venmo_handle ? (
            <Text style={styles.memberDetail}>Venmo: {item.player.venmo_handle}</Text>
          ) : null}
        </View>
        <View style={styles.memberRight}>
          {item.role === 'admin' && (
            <View style={styles.adminBadge}>
              <Text style={styles.adminBadgeText}>Admin</Text>
            </View>
          )}
          {item.is_active !== 1 && (
            <Text style={styles.inactiveLabel}>Inactive</Text>
          )}
          {canEdit && <Text style={styles.chevron}>{'\u203A'}</Text>}
        </View>
      </View>
    </Pressable>
  );

  return (
    <View style={styles.screen}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <View style={styles.headerRow}>
          <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backButton}>
            <Text style={styles.backArrow}>{'\u2039'}</Text>
          </Pressable>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {group_name ? decodeURIComponent(group_name) : 'Members'}
          </Text>
          <View style={styles.backButton} />
        </View>
      </View>

      {saveMsg && (
        <View style={[styles.msgBanner, { backgroundColor: saveMsg === 'Saved' ? '#E8F5E9' : '#FFEBEE' }]}>
          <Text style={{ color: saveMsg === 'Saved' ? '#2E7D32' : '#C62828' }}>{saveMsg}</Text>
        </View>
      )}

      {loading ? (
        <ActivityIndicator style={styles.spinner} size="large" color={OLIVE} />
      ) : error ? (
        <View style={styles.errorCard}><Text style={styles.errorText}>{error}</Text></View>
      ) : (
        <FlatList
          data={[...activeMembers, ...inactiveMembers]}
          keyExtractor={(item) => item.id}
          renderItem={renderMember}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: insets.bottom + 24 }}
          ListHeaderComponent={
            <Text style={styles.sectionHeader}>
              Active ({activeMembers.length}){inactiveMembers.length > 0 ? ` + ${inactiveMembers.length} inactive` : ''}
            </Text>
          }
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        />
      )}

      {/* Edit modal */}
      <Modal visible={editMember !== null} animationType="slide" transparent>
        <View style={styles.modalWrap}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setEditMember(null)} />
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Edit Player</Text>
              <Pressable onPress={() => setEditMember(null)}>
                <Text style={styles.modalClose}>{'\u2715'}</Text>
              </Pressable>
            </View>

            <Text style={styles.fieldLabel}>Display Name</Text>
            <TextInput style={styles.input} value={editDisplayName} onChangeText={setEditDisplayName} />

            <Text style={styles.fieldLabel}>Full Name</Text>
            <TextInput style={styles.input} value={editFullName} onChangeText={setEditFullName} placeholder="Optional" placeholderTextColor="#999" />

            <Text style={styles.fieldLabel}>Venmo Handle</Text>
            <TextInput style={styles.input} value={editVenmo} onChangeText={setEditVenmo} placeholder="Optional" placeholderTextColor="#999" autoCapitalize="none" />

            <Text style={styles.fieldLabel}>Active</Text>
            <View style={styles.toggleRow}>
              <Pressable
                style={[styles.toggleBtn, editActive === 1 && styles.toggleBtnActive]}
                onPress={() => setEditActive(1)}
              >
                <Text style={[styles.toggleText, editActive === 1 && styles.toggleTextActive]}>Yes</Text>
              </Pressable>
              <Pressable
                style={[styles.toggleBtn, editActive !== 1 && styles.toggleBtnInactive]}
                onPress={() => setEditActive(0)}
              >
                <Text style={[styles.toggleText, editActive !== 1 && styles.toggleTextInactive]}>No</Text>
              </Pressable>
            </View>

            <Pressable
              style={[styles.saveBtn, saving && { opacity: 0.6 }]}
              onPress={handleSave}
              disabled={saving}
            >
              <Text style={styles.saveBtnText}>{saving ? 'Saving...' : 'Save'}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F5F5F5' },
  header: { backgroundColor: OLIVE },
  headerRow: { height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  backButton: { width: 32, height: 32, justifyContent: 'center', alignItems: 'center' },
  backArrow: { fontSize: 32, color: '#FFF', fontWeight: '300', lineHeight: 36 },
  headerTitle: { fontSize: 17, fontWeight: '600', color: '#FFF', textAlign: 'center', flex: 1 },
  spinner: { marginVertical: 40 },
  errorCard: { backgroundColor: '#FFEBEE', borderRadius: 10, padding: 14, margin: 16 },
  errorText: { color: '#C62828', fontSize: 14 },
  msgBanner: { padding: 10, marginHorizontal: 16, marginTop: 8, borderRadius: 8 },
  sectionHeader: { fontSize: 15, fontWeight: '600', color: '#666', marginBottom: 8 },

  memberCard: {
    backgroundColor: '#FFF',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E0E0E0',
  },
  memberRow: { flexDirection: 'row', alignItems: 'center' },
  memberInfo: { flex: 1 },
  memberName: { fontSize: 16, fontWeight: '600', color: '#1A1A1A' },
  memberDetail: { fontSize: 13, color: '#8E8E93', marginTop: 2 },
  memberRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  adminBadge: { backgroundColor: '#E8F5E9', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  adminBadgeText: { fontSize: 11, fontWeight: '600', color: '#2E7D32' },
  inactiveLabel: { fontSize: 12, color: '#C62828', fontWeight: '600' },
  chevron: { fontSize: 22, color: '#8E8E93' },

  modalWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#FFF', borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingHorizontal: 20, paddingTop: 16 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  modalTitle: { fontSize: 20, fontWeight: '700', color: '#1A1A1A' },
  modalClose: { fontSize: 20, color: '#8E8E93', padding: 4 },

  fieldLabel: { fontSize: 13, fontWeight: '600', color: '#666', marginTop: 12, marginBottom: 4 },
  input: {
    borderWidth: 1, borderColor: '#DDD', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: '#1A1A1A',
    backgroundColor: '#FAFAFA',
  },
  toggleRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  toggleBtn: {
    flex: 1, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: '#DDD',
    alignItems: 'center', backgroundColor: '#FAFAFA',
  },
  toggleBtnActive: { backgroundColor: '#E8F5E9', borderColor: '#2E7D32' },
  toggleBtnInactive: { backgroundColor: '#FFEBEE', borderColor: '#C62828' },
  toggleText: { fontSize: 15, fontWeight: '600', color: '#666' },
  toggleTextActive: { color: '#2E7D32' },
  toggleTextInactive: { color: '#C62828' },

  saveBtn: {
    backgroundColor: OLIVE, borderRadius: 10, paddingVertical: 14,
    alignItems: 'center', marginTop: 20,
  },
  saveBtnText: { color: '#FFF', fontSize: 17, fontWeight: '600' },
});
