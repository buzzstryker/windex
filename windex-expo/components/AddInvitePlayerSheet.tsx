import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError } from '@/lib/api';
import {
  addPlayerToGroup,
  buildSignInInstructions,
  copyToClipboard,
  createPlayer,
  deriveInviteStatus,
  findPlayerByEmail,
  getPlayersAuthStatus,
  reactivateMembership,
  searchPlayers,
  sendInvite,
  type InviteStatus,
  type PlayerAuthStatus,
  type PlayerLite,
} from '@/lib/playerInvite';

const OLIVE = '#4B5E2A';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PILL: Record<InviteStatus, { label: string; color: string; bg: string }> = {
  not_invited: { label: 'Not invited', color: '#616161', bg: '#F0F0F0' },
  invited: { label: 'Invited — awaiting first sign-in', color: '#B26A00', bg: '#FFF3E0' },
  signed_in: { label: 'Signed in', color: '#2E7D32', bg: '#E8F5E9' },
};

/** One group_members row, as the parent's members list already has it. */
export type MembershipLite = { id: string; is_active: number; role: string };

/**
 * Is a matched player in THIS group? 'unknown' when the parent didn't supply
 * membership data — the sheet then falls back to invite-only actions rather
 * than guessing "not a member" and offering a bogus Add.
 */
type MembershipState = 'member' | 'inactive' | 'none' | 'unknown';

type PendingAction = {
  player: PlayerLite;
  kind: 'add' | 'reactivate';
  membershipId?: string;
  withInvite: boolean;
};

type Props = {
  visible: boolean;
  groupId: string;
  groupName?: string;
  /** player_id → their group_members row for this group. Absent → invite-only. */
  membershipByPlayerId?: Map<string, MembershipLite>;
  onClose: () => void;
  onChanged: () => void;
};

export function AddInvitePlayerSheet({
  visible,
  groupId,
  groupName,
  membershipByPlayerId,
  onClose,
  onChanged,
}: Props) {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<'search' | 'new'>('search');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlayerLite[]>([]);
  const [searching, setSearching] = useState(false);
  const [authStatus, setAuthStatus] = useState<Map<string, PlayerAuthStatus>>(new Map());

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [sendNow, setSendNow] = useState(true);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const groupLabel = groupName ? decodeURIComponent(groupName) : 'this group';

  const membershipOf = (p: PlayerLite): MembershipState => {
    if (!membershipByPlayerId) return 'unknown';
    const m = membershipByPlayerId.get(p.id);
    if (!m) return 'none';
    return m.is_active === 1 ? 'member' : 'inactive';
  };

  // Reset when opened; load auth status once.
  useEffect(() => {
    if (!visible) return;
    setMode('search');
    setQuery('');
    setResults([]);
    setFullName('');
    setEmail('');
    setDisplayName('');
    setSendNow(true);
    setBusy(false);
    setNotice(null);
    setError(null);
    setPending(null);
    getPlayersAuthStatus().then(setAuthStatus).catch(() => setAuthStatus(new Map()));
  }, [visible]);

  // Debounced search.
  useEffect(() => {
    if (!visible || mode !== 'search') return;
    const term = query.trim();
    if (term.length < 2) { setResults([]); setSearching(false); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await searchPlayers(term);
        if (!cancelled) setResults(r);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, mode, visible]);

  const refreshStatus = () => getPlayersAuthStatus().then(setAuthStatus).catch(() => {});

  const handleSendInvite = async (p: PlayerLite) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await sendInvite(p.id);
      setNotice(
        res.already_had_auth
          ? `${p.display_name} already had an account — linked, no email sent.`
          : res.invite_sent
            ? `Invite sent to ${p.email ?? p.display_name}.`
            : `Invite request returned without change — refresh and verify.`,
      );
      await refreshStatus();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send invite');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Execute a confirmed add / reactivate, then (optionally) the invite.
   * Partial-failure handling mirrors handleCreate: if the membership write
   * succeeds and the invite fails, that is surfaced loudly and is recoverable
   * from search (the card now shows a Send Invite action). If the membership
   * write fails, the invite is never attempted — nothing half-done.
   */
  const handleConfirmPending = async () => {
    if (!pending) return;
    const { player: p, kind, membershipId, withInvite } = pending;
    setBusy(true); setError(null); setNotice(null);
    try {
      if (kind === 'add') {
        await addPlayerToGroup(groupId, p.id);
      } else {
        if (!membershipId) throw new Error('Missing membership row — refresh and try again.');
        await reactivateMembership(membershipId);
      }
      const done = kind === 'add' ? `Added ${p.display_name} to` : `Reactivated ${p.display_name} in`;
      if (withInvite) {
        try {
          await sendInvite(p.id);
          setNotice(`${done} ${groupLabel} and sent an invite to ${p.email ?? p.display_name}.`);
        } catch (e) {
          const why = e instanceof Error ? e.message : 'unknown error';
          setNotice(`${done} ${groupLabel} — invite failed: ${why}. Find them in search to retry Send Invite.`);
        }
      } else {
        setNotice(`${done} ${groupLabel}.`);
      }
      setPending(null);
      onChanged();
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update membership');
      setPending(null);
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async (p: PlayerLite) => {
    const text = buildSignInInstructions(p.email ?? '');
    const ok = await copyToClipboard(text);
    setNotice(ok ? 'Sign-in instructions copied.' : text);
  };

  const showExistingByEmail = async (addr: string, reason: string) => {
    const existing = await findPlayerByEmail(addr);
    setMode('search');
    setQuery(addr);
    setResults(existing ? [existing] : []);
    setNotice(existing ? `${reason} ${existing.display_name}.` : reason);
  };

  const handleCreate = async () => {
    const fn = fullName.trim();
    const em = email.trim();
    if (!fn) { setError('Full name is required.'); return; }
    if (!EMAIL_RE.test(em)) { setError('A valid email is required.'); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      // Catch a duplicate email BEFORE any write and bounce to the match view.
      const dup = await findPlayerByEmail(em);
      if (dup) {
        await refreshStatus();
        await showExistingByEmail(em, 'This email already belongs to');
        return;
      }
      const created = await createPlayer({ full_name: fn, email: em, display_name: displayName, group_id: groupId });
      const newId = created.player.id;
      const genName = created.player.display_name;
      if (sendNow) {
        try {
          await sendInvite(newId);
          setNotice(`Created ${genName} and sent an invite to ${em}.`);
        } catch (e) {
          // Recoverable partial failure: the player exists (findable in search
          // → Send Invite). Never a silent half-success.
          const why = e instanceof Error ? e.message : 'unknown error';
          setNotice(`Player ${genName} created — invite failed: ${why}. Find them in search to retry Send Invite.`);
        }
      } else {
        setNotice(`Created ${genName}.`);
      }
      onChanged();
      await refreshStatus();
      setMode('search');
      setQuery('');
    } catch (e) {
      // 409 race backstop: created-elsewhere between our check and insert.
      if (e instanceof ApiError && e.status === 409) {
        await showExistingByEmail(em, 'This email already belongs to');
      } else {
        setError(e instanceof Error ? e.message : 'Failed to create player');
      }
    } finally {
      setBusy(false);
    }
  };

  const renderMatch = (p: PlayerLite) => {
    const status = deriveInviteStatus(p.user_id, authStatus.get(p.id));
    const pill = PILL[status];
    const emailOk = EMAIL_RE.test(p.email ?? '');
    const membership = membershipOf(p);
    const row = membershipByPlayerId?.get(p.id);
    // Only a never-invited player gets the invite paired onto the add, and only
    // if we have an address to send to. Without one the add still proceeds —
    // a missing email must not block getting them into the group.
    const withInvite = status === 'not_invited' && emailOk;
    const canJoin = membership === 'none' || membership === 'inactive';
    const joinLabel =
      membership === 'inactive'
        ? withInvite ? 'Reactivate & Send Invite' : `Reactivate in ${groupLabel}`
        : withInvite ? 'Add & Send Invite' : `Add to ${groupLabel}`;

    return (
      <View key={p.id} style={styles.matchCard}>
        <View style={{ flex: 1 }}>
          <Text style={styles.matchName}>{p.display_name}</Text>
          {p.full_name ? <Text style={styles.matchSub}>{p.full_name}</Text> : null}
          {p.email ? <Text style={styles.matchSub}>{p.email}</Text> : null}
          {membership !== 'unknown' && (
            <Text
              style={[
                styles.membershipLine,
                membership === 'member' && styles.membershipIn,
                membership === 'inactive' && styles.membershipWas,
              ]}
            >
              {membership === 'member'
                ? 'Member of this group'
                : membership === 'inactive'
                  ? 'Previously in this group (inactive)'
                  : 'Not in this group'}
            </Text>
          )}
          {p.retired_at ? <Text style={styles.retiredLine}>Retired</Text> : null}
          <View style={[styles.pill, { backgroundColor: pill.bg }]}>
            <Text style={[styles.pillText, { color: pill.color }]}>{pill.label}</Text>
          </View>
          {canJoin && status === 'not_invited' && !emailOk ? (
            <Text style={styles.matchNote}>No valid email — they can be added, but not invited.</Text>
          ) : null}
        </View>
        <View style={styles.matchActions}>
          {canJoin && (
            <Pressable
              style={[styles.smallBtn, styles.primaryBtn, busy && { opacity: 0.5 }]}
              onPress={busy ? undefined : () => {
                setError(null); setNotice(null);
                setPending({
                  player: p,
                  kind: membership === 'inactive' ? 'reactivate' : 'add',
                  membershipId: row?.id,
                  withInvite,
                });
              }}
            >
              <Text style={styles.primaryBtnText}>{joinLabel}</Text>
            </Pressable>
          )}
          {/* Invite-only actions. Send Invite is the primary only for a player
              already in this group (or when membership is unknown) — otherwise
              the add above carries the invite. */}
          {!canJoin && status === 'not_invited' && (
            <Pressable
              style={[styles.smallBtn, styles.primaryBtn, (!emailOk || busy) && { opacity: 0.5 }]}
              onPress={emailOk && !busy ? () => handleSendInvite(p) : undefined}
            >
              <Text style={styles.primaryBtnText}>Send Invite</Text>
            </Pressable>
          )}
          {status === 'invited' && (
            <Pressable style={[styles.smallBtn, styles.secondaryBtn, canJoin && { marginTop: 8 }]} onPress={() => handleCopy(p)}>
              <Text style={styles.secondaryBtnText}>Copy sign-in instructions</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  };

  /**
   * Confirmation lives INSIDE the sheet rather than in a nested <Modal>:
   * this component is already a Modal, and stacking a second one is unreliable
   * on RN-web / the PWA. Cancel returns to the results list untouched.
   */
  const renderConfirm = (act: PendingAction) => {
    const { player: p, kind, withInvite } = act;
    const verb = kind === 'reactivate' ? 'Reactivate' : 'Add';
    const prep = kind === 'reactivate' ? 'in' : 'to';
    return (
      <View style={styles.confirmPanel}>
        <Text style={styles.confirmTitle}>{`${verb} ${p.display_name} ${prep} ${groupLabel}?`}</Text>
        <Text style={styles.confirmSub}>
          {[p.full_name, p.email].filter(Boolean).join(' · ') || p.display_name}
        </Text>
        {kind === 'reactivate' ? (
          <Text style={styles.confirmNote}>Their original join date and role are kept.</Text>
        ) : null}
        {withInvite ? (
          <Text style={styles.confirmNote}>{`An invite email will also be sent to ${p.email}.`}</Text>
        ) : null}
        {p.retired_at ? (
          <Text style={styles.confirmWarn}>This player is retired — they won’t appear in standings.</Text>
        ) : null}
        <View style={styles.confirmRow}>
          <Pressable
            style={[styles.smallBtn, styles.secondaryBtn, styles.confirmBtn]}
            onPress={busy ? undefined : () => setPending(null)}
          >
            <Text style={styles.secondaryBtnText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.smallBtn, styles.primaryBtn, styles.confirmBtn, busy && { opacity: 0.6 }]}
            onPress={busy ? undefined : handleConfirmPending}
            disabled={busy}
          >
            <Text style={styles.primaryBtnText}>
              {busy ? 'Working…' : `${verb} ${prep === 'in' ? 'in' : 'to'} ${groupLabel}`}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  };

  const showNoMatch = mode === 'search' && query.trim().length >= 2 && !searching && results.length === 0;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.wrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.header}>
            <Text style={styles.title}>{mode === 'search' ? 'Add / Invite Player' : 'New Player'}</Text>
            <Pressable onPress={onClose} hitSlop={8}><Text style={styles.close}>{'✕'}</Text></Pressable>
          </View>
          {groupName ? <Text style={styles.groupHint}>into {decodeURIComponent(groupName)}</Text> : null}

          {notice ? <View style={styles.noticeBox}><Text style={styles.noticeText}>{notice}</Text></View> : null}
          {error ? <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View> : null}

          {pending ? (
            renderConfirm(pending)
          ) : mode === 'search' ? (
            <>
              <TextInput
                style={styles.input}
                value={query}
                onChangeText={setQuery}
                placeholder="Search by name or email…"
                placeholderTextColor="#999"
                autoCapitalize="none"
                autoFocus
              />
              <ScrollView style={styles.results} keyboardShouldPersistTaps="handled">
                {searching ? (
                  <ActivityIndicator style={{ marginTop: 16 }} color={OLIVE} />
                ) : results.length > 0 ? (
                  results.map(renderMatch)
                ) : showNoMatch ? (
                  <View style={styles.noMatch}>
                    <Text style={styles.noMatchText}>No player matches “{query.trim()}”.</Text>
                    <Pressable
                      style={[styles.smallBtn, styles.primaryBtn]}
                      onPress={() => {
                        const q = query.trim();
                        setEmail(q.includes('@') ? q : '');
                        setFullName(q.includes('@') ? '' : q);
                        setDisplayName('');
                        setError(null);
                        setNotice(null);
                        setMode('new');
                      }}
                    >
                      <Text style={styles.primaryBtnText}>+ Add new player</Text>
                    </Pressable>
                  </View>
                ) : (
                  <Text style={styles.hint}>Type at least 2 characters to search.</Text>
                )}
              </ScrollView>
            </>
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.fieldLabel}>Full name *</Text>
              <TextInput style={styles.input} value={fullName} onChangeText={setFullName} placeholder="Jane Doe" placeholderTextColor="#999" autoFocus />
              <Text style={styles.fieldLabel}>Email *</Text>
              <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="jane@example.com" placeholderTextColor="#999" autoCapitalize="none" keyboardType="email-address" />
              <Text style={styles.fieldLabel}>Display name (optional)</Text>
              <TextInput style={styles.input} value={displayName} onChangeText={setDisplayName} placeholder="Leave blank to auto-generate" placeholderTextColor="#999" autoCapitalize="none" />
              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>Send invite now</Text>
                <Switch value={sendNow} onValueChange={setSendNow} trackColor={{ true: OLIVE }} />
              </View>
              <Pressable style={[styles.wideBtn, busy && { opacity: 0.6 }]} onPress={busy ? undefined : handleCreate} disabled={busy}>
                <Text style={styles.wideBtnText}>{busy ? 'Creating…' : 'Create Player'}</Text>
              </Pressable>
              <Pressable style={styles.backLink} onPress={() => { setMode('search'); setError(null); }}>
                <Text style={styles.backLinkText}>{'‹'} Back to search</Text>
              </Pressable>
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#FFF', borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingHorizontal: 20, paddingTop: 16, maxHeight: '88%' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 20, fontWeight: '700', color: '#1A1A1A' },
  close: { fontSize: 20, color: '#8E8E93', padding: 4 },
  groupHint: { fontSize: 13, color: '#8E8E93', marginTop: 2, marginBottom: 8 },
  noticeBox: { backgroundColor: '#E8F5E9', borderRadius: 8, padding: 10, marginBottom: 8 },
  noticeText: { color: '#2E7D32', fontSize: 13 },
  errorBox: { backgroundColor: '#FFEBEE', borderRadius: 8, padding: 10, marginBottom: 8 },
  errorText: { color: '#C62828', fontSize: 13 },
  input: { borderWidth: 1, borderColor: '#DDD', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: '#1A1A1A', backgroundColor: '#FAFAFA', marginTop: 4, marginBottom: 4 },
  results: { marginTop: 8 },
  hint: { color: '#8E8E93', fontSize: 13, marginTop: 12, textAlign: 'center' },
  noMatch: { alignItems: 'center', marginTop: 16, gap: 12 },
  noMatchText: { color: '#666', fontSize: 14 },
  matchCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 12, padding: 12, marginBottom: 8, gap: 8 },
  matchName: { fontSize: 16, fontWeight: '600', color: '#1A1A1A' },
  matchSub: { fontSize: 13, color: '#8E8E93', marginTop: 1 },
  pill: { alignSelf: 'flex-start', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, marginTop: 6 },
  pillText: { fontSize: 11, fontWeight: '600' },
  membershipLine: { fontSize: 12, fontWeight: '600', color: '#8E8E93', marginTop: 4 },
  membershipIn: { color: '#2E7D32' },
  membershipWas: { color: '#B26A00' },
  retiredLine: { fontSize: 12, fontWeight: '600', color: '#C62828', marginTop: 2 },
  matchNote: { fontSize: 11, color: '#8E8E93', marginTop: 6 },
  matchActions: { justifyContent: 'center' },
  confirmPanel: { paddingVertical: 12 },
  confirmTitle: { fontSize: 17, fontWeight: '700', color: '#1A1A1A' },
  confirmSub: { fontSize: 14, color: '#8E8E93', marginTop: 6 },
  confirmNote: { fontSize: 13, color: '#666', marginTop: 10 },
  confirmWarn: { fontSize: 13, color: '#C62828', fontWeight: '600', marginTop: 10 },
  confirmRow: { flexDirection: 'row', gap: 10, marginTop: 22 },
  confirmBtn: { flex: 1, paddingVertical: 13, maxWidth: undefined },
  smallBtn: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center' },
  primaryBtn: { backgroundColor: OLIVE },
  primaryBtnText: { color: '#FFF', fontSize: 13, fontWeight: '600' },
  secondaryBtn: { borderWidth: 1, borderColor: '#DDD', backgroundColor: '#FAFAFA', maxWidth: 150 },
  secondaryBtnText: { color: '#1A1A1A', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: '#666', marginTop: 12, marginBottom: 2 },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 },
  switchLabel: { fontSize: 15, color: '#1A1A1A', fontWeight: '600' },
  wideBtn: { backgroundColor: OLIVE, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  wideBtnText: { color: '#FFF', fontSize: 17, fontWeight: '600' },
  backLink: { alignItems: 'center', marginTop: 14 },
  backLinkText: { color: OLIVE, fontSize: 15, fontWeight: '600' },
});
