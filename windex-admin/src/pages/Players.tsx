import { useEffect, useState, useCallback } from 'react';
import { PageHeader } from '../components/PageHeader';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { ConfirmToast } from '../components/ConfirmToast';
import { ConfirmModal } from '../components/ConfirmModal';
import { AddPlayerModal } from '../components/AddPlayerModal';
import { isCurrentUserSuperAdmin, listGroups } from '../api/groups';
import {
  listPlayersWithMembership, updatePlayer, updateMembership,
  sendInvite, PlayerAlreadyLinkedError,
  sendInviteAgain, PlayerAlreadySignedInError, PlayerNotYetInvitedError,
  getPlayersAuthStatus,
  type PlayerWithMembership, type PlayerAuthStatus,
} from '../api/playerAdmin';
import { getAuthToken } from '../api/client';
import type { Group } from '../types';

function getCurrentUserId(): string | null {
  const token = getAuthToken();
  if (!token) return null;
  try {
    return JSON.parse(atob(token.split('.')[1])).sub;
  } catch {
    return null;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const hasValidEmail = (email: string | null) =>
  !!email && EMAIL_RE.test(email.trim());

type InviteMode = 'first' | 'again';

// ─── Status column ────────────────────────────────────────────────────────
// Three-state derivation from players.user_id + the get_players_auth_status
// RPC. Returns null when we don't have enough info yet (RPC still loading
// for a linked player). The "not invited" state is derivable from the row
// alone, so it renders immediately.
type StatusKey = 'not_invited' | 'invited' | 'signed_in';

function deriveStatus(
  player: PlayerWithMembership,
  authStatus: PlayerAuthStatus | null
): StatusKey | null {
  if (!player.user_id) return 'not_invited';
  if (!authStatus) return null;
  return authStatus.has_signed_in ? 'signed_in' : 'invited';
}

const STATUS_PILL: Record<StatusKey, { label: string; color: string; bg: string; border: string }> = {
  not_invited: { label: 'not invited', color: '#616161', bg: '#f5f5f5', border: '#e0e0e0' },
  invited:     { label: 'invited',     color: '#f57c00', bg: '#fff8e1', border: '#ffe0b2' },
  signed_in:   { label: 'signed in',   color: '#2e7d32', bg: '#e8f5e9', border: '#a5d6a7' },
};

function StatusPill({ status }: { status: StatusKey | null }) {
  if (!status) return <span style={{ color: '#999', fontSize: 12 }}>—</span>;
  const s = STATUS_PILL[status];
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 8px',
        fontSize: 11,
        fontWeight: 600,
        color: s.color,
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: 10,
        whiteSpace: 'nowrap',
      }}
    >
      {s.label}
    </span>
  );
}

export function Players() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState('');
  const [players, setPlayers] = useState<PlayerWithMembership[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Per-player auth status from get_players_auth_status RPC (migration 027).
  // Empty until the RPC resolves; rows render the conservative "no Send Again"
  // affordance until then so we never surface the button against a player who
  // may have already signed in.
  const [authStatus, setAuthStatus] = useState<Map<string, PlayerAuthStatus>>(new Map());
  // Invite flow state — shared between first-send and send-again. inviteMode
  // selects ConfirmModal copy + which backend the handler dispatches to.
  const [inviteTarget, setInviteTarget] = useState<PlayerWithMembership | null>(null);
  const [inviteMode, setInviteMode] = useState<InviteMode>('first');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  useEffect(() => {
    listGroups().then(setGroups).catch(() => {});
    isCurrentUserSuperAdmin().then(setIsSuperAdmin).catch(() => setIsSuperAdmin(false));
  }, []);

  // Load auth status whenever we become a super admin. Non-admins get an
  // empty map from the RPC (it self-gates) so this is a safe no-op too.
  const loadAuthStatus = useCallback(() => {
    getPlayersAuthStatus()
      .then(setAuthStatus)
      .catch(() => setAuthStatus(new Map()));
  }, []);

  useEffect(() => {
    if (isSuperAdmin) loadAuthStatus();
  }, [isSuperAdmin, loadAuthStatus]);

  const load = useCallback(async () => {
    if (!groupId) { setPlayers([]); return; }
    setLoading(true);
    setError(null);
    try {
      const list = await listPlayersWithMembership(groupId);
      setPlayers(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (p: PlayerWithMembership, fields: {
    display_name: string;
    full_name: string;
    email: string;
    venmo_handle: string;
    role: string;
    is_active: number;
  }) => {
    if (!getCurrentUserId()) { setSaveMsg('Not signed in'); return; }
    setSaving(true);
    setSaveMsg(null);
    try {
      await updatePlayer(p.id, {
        display_name: fields.display_name,
        full_name: fields.full_name || null,
        email: fields.email || null,
        venmo_handle: fields.venmo_handle || null,
        is_active: fields.is_active,
      });
      await updateMembership(p.membership.id, {
        role: fields.role,
        is_active: fields.is_active,
      });
      setSaveMsg('Saved');
      setEditingId(null);
      load();
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmInvite = async () => {
    if (!inviteTarget) return;
    setInviting(true);
    setInviteError(null);
    try {
      if (inviteMode === 'first') {
        const res = await sendInvite(inviteTarget.id);
        let line: string;
        if (res.already_had_auth) {
          line = `Auth account already existed for ${inviteTarget.email}; linked without re-emailing.`;
        } else if (res.invite_sent && res.linked) {
          line = `Invite sent to ${inviteTarget.email}.`;
        } else if (res.invite_sent && !res.linked) {
          line = `Invite sent to ${inviteTarget.email}, but auto-link didn't fire. Refresh and check the player's email.`;
        } else {
          line = `Invite request returned without change. Refresh and verify.`;
        }
        setToast(line);
      } else {
        await sendInviteAgain(inviteTarget.id);
        setToast(`Invite sent again to ${inviteTarget.email}.`);
      }
      setInviteTarget(null);
      load();
      loadAuthStatus(); // refresh per-row state so button transitions reflect server truth
    } catch (e) {
      if (e instanceof PlayerAlreadyLinkedError) {
        setInviteError('This player is already linked to an auth user. Refresh the page.');
      } else if (e instanceof PlayerAlreadySignedInError) {
        setInviteError('This player has already signed in — no re-invite needed. Refresh the page.');
      } else if (e instanceof PlayerNotYetInvitedError) {
        setInviteError('This player has never been invited. Refresh and use Send Invite instead.');
      } else {
        setInviteError(e instanceof Error ? e.message : 'Failed to send invite');
      }
    } finally {
      setInviting(false);
    }
  };

  // ConfirmModal copy varies by mode; build it inline.
  const modalTitle = inviteMode === 'again' ? 'Send invite again' : 'Send invite';
  const modalConfirmLabel = inviteMode === 'again' ? 'Send again' : 'Send invite';

  return (
    <>
      <PageHeader title="Players" subtitle="View and manage player data by group." />

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div className="form-section" style={{ maxWidth: 300, marginBottom: 0 }}>
            <label htmlFor="pl-group">Group</label>
            <select id="pl-group" value={groupId} onChange={(e) => { setGroupId(e.target.value); setEditingId(null); }}>
              <option value="">Select group...</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          {isSuperAdmin && (
            <button
              className="btn btn-primary"
              onClick={() => { setSaveMsg(null); setAddOpen(true); }}
              style={{ padding: '8px 14px' }}
            >
              + Add Player
            </button>
          )}
        </div>
      </div>

      {isSuperAdmin && (
        <AddPlayerModal
          open={addOpen}
          groups={groups}
          onClose={() => setAddOpen(false)}
          onSuccess={(result) => {
            setAddOpen(false);
            const lines = [`Player ${result.player.display_name} created`];
            if (result.invite_sent) {
              lines.push(`Invite sent to ${result.player.email ?? ''}`);
            } else if (result.already_had_auth) {
              lines.push('Auth account already existed; linked or will auto-link on next sign-in');
            }
            setToast(lines.join(' — '));
            if (groupId) load();
            loadAuthStatus();
          }}
        />
      )}

      <ConfirmModal
        open={inviteTarget !== null}
        title={modalTitle}
        confirmLabel={modalConfirmLabel}
        busy={inviting}
        errorMessage={inviteError}
        onCancel={() => { setInviteTarget(null); setInviteError(null); }}
        onConfirm={handleConfirmInvite}
      >
        {inviteTarget && inviteMode === 'first' && (
          <div style={{ fontSize: 14, lineHeight: 1.5 }}>
            <p style={{ margin: 0 }}>
              Send an OTP invite to <strong>{inviteTarget.display_name}</strong> at{' '}
              <code>{inviteTarget.email}</code>?
            </p>
            <p style={{ margin: '12px 0 0', color: '#666', fontSize: 13 }}>
              The player will receive a sign-in email. If they already have an auth
              account under that email, we'll link the player record without sending
              a new email.
            </p>
          </div>
        )}
        {inviteTarget && inviteMode === 'again' && (
          <div style={{ fontSize: 14, lineHeight: 1.5 }}>
            <p style={{ margin: 0 }}>
              Send invite again to <strong>{inviteTarget.display_name}</strong> at{' '}
              <code>{inviteTarget.email}</code>?
            </p>
            <p style={{ margin: '12px 0 0', color: '#666', fontSize: 13 }}>
              This will invalidate any previous invite link and send a fresh one.
            </p>
          </div>
        )}
      </ConfirmModal>

      {toast && <ConfirmToast message={toast} onClose={() => setToast(null)} duration={5000} />}

      {loading && <LoadingSpinner />}
      {error && <ErrorState message={error} onRetry={load} />}
      {saveMsg && <div style={{ padding: '8px 16px', margin: '8px 0', background: saveMsg === 'Saved' ? '#e8f5e9' : '#ffebee', borderRadius: 4 }}>{saveMsg}</div>}

      {!loading && groupId && players.length === 0 && (
        <EmptyState message="No players in this group." />
      )}

      {players.length > 0 && (
        <div className="card">
          <h2>Members ({players.length})</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
                <th style={{ padding: '8px 10px' }}>Name</th>
                <th style={{ padding: '8px 10px' }}>Full Name</th>
                <th style={{ padding: '8px 10px' }}>Email</th>
                <th style={{ padding: '8px 10px' }}>Status</th>
                <th style={{ padding: '8px 10px' }}>Venmo</th>
                <th style={{ padding: '8px 10px' }}>Role</th>
                <th style={{ padding: '8px 10px' }}>Active</th>
                <th style={{ padding: '8px 10px' }}></th>
              </tr>
            </thead>
            <tbody>
              {players.map((p) => (
                editingId === p.id
                  ? <EditRow
                      key={p.id}
                      player={p}
                      authStatus={authStatus.get(p.id) ?? null}
                      onSave={(f) => handleSave(p, f)}
                      onCancel={() => setEditingId(null)}
                      saving={saving}
                    />
                  : <DisplayRow
                      key={p.id}
                      player={p}
                      isSuperAdmin={isSuperAdmin}
                      authStatus={authStatus.get(p.id) ?? null}
                      onEdit={() => { setEditingId(p.id); setSaveMsg(null); }}
                      onSendInvite={() => { setInviteMode('first'); setInviteError(null); setInviteTarget(p); }}
                      onSendInviteAgain={() => { setInviteMode('again'); setInviteError(null); setInviteTarget(p); }}
                    />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function DisplayRow({
  player: p,
  isSuperAdmin,
  authStatus,
  onEdit,
  onSendInvite,
  onSendInviteAgain,
}: {
  player: PlayerWithMembership;
  isSuperAdmin: boolean;
  authStatus: PlayerAuthStatus | null;
  onEdit: () => void;
  onSendInvite: () => void;
  onSendInviteAgain: () => void;
}) {
  const linked = p.user_id !== null && p.user_id !== undefined;
  const emailOk = hasValidEmail(p.email);
  const inviteDisabledReason = !emailOk
    ? (p.email ? 'Email is invalid' : 'Add an email first')
    : null;

  // Three-state derivation for the action affordance:
  //   showSendInvite     — never invited (no user_id). Existing first-send flow.
  //   showSendAgain      — invited, but not yet confirmed/signed in.
  //                        Requires auth status to confirm (conservative until
  //                        the RPC resolves so we don't surface "Send Again"
  //                        against someone who actually signed in already).
  //   showBadgeOnly      — fully active. No button.
  const showSendInvite = isSuperAdmin && !linked;
  const showSendAgain =
    isSuperAdmin
    && linked
    && authStatus !== null
    && !authStatus.has_signed_in;

  const status = deriveStatus(p, authStatus);

  return (
    <tr style={{ borderBottom: '1px solid #eee' }}>
      <td style={{ padding: '6px 10px', fontWeight: 600 }}>{p.display_name}</td>
      <td style={{ padding: '6px 10px', color: '#666' }}>{p.full_name ?? '—'}</td>
      <td style={{ padding: '6px 10px', color: '#666' }}>{p.email ?? '—'}</td>
      <td style={{ padding: '6px 10px' }}><StatusPill status={status} /></td>
      <td style={{ padding: '6px 10px', color: '#666' }}>{p.venmo_handle ?? '—'}</td>
      <td style={{ padding: '6px 10px' }}>{p.membership.role}</td>
      <td style={{ padding: '6px 10px' }}>
        <span style={{ color: p.membership.is_active ? '#2e7d32' : '#c62828', fontWeight: 600 }}>
          {p.membership.is_active ? 'Yes' : 'No'}
        </span>
      </td>
      <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
        {showSendInvite && (
          <button
            className="btn btn-primary"
            onClick={emailOk ? onSendInvite : undefined}
            disabled={!emailOk}
            title={inviteDisabledReason ?? ''}
            style={{ padding: '4px 10px', fontSize: 12, marginRight: 4, opacity: emailOk ? 1 : 0.55 }}
          >
            Send Invite
          </button>
        )}
        {showSendAgain && (
          <button
            className="btn btn-primary"
            onClick={onSendInviteAgain}
            style={{ padding: '4px 10px', fontSize: 12, marginRight: 4 }}
          >
            Send Again
          </button>
        )}
        <button className="btn btn-secondary" onClick={onEdit} style={{ padding: '4px 10px', fontSize: 12 }}>Edit</button>
      </td>
    </tr>
  );
}

function EditRow({ player: p, authStatus, onSave, onCancel, saving }: {
  player: PlayerWithMembership;
  authStatus: PlayerAuthStatus | null;
  onSave: (fields: { display_name: string; full_name: string; email: string; venmo_handle: string; role: string; is_active: number }) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [displayName, setDisplayName] = useState(p.display_name);
  const [fullName, setFullName] = useState(p.full_name ?? '');
  const [email, setEmail] = useState(p.email ?? '');
  const [venmo, setVenmo] = useState(p.venmo_handle ?? '');
  const [role, setRole] = useState(p.membership.role);
  const [active, setActive] = useState(p.membership.is_active);
  const status = deriveStatus(p, authStatus);

  return (
    <tr style={{ borderBottom: '1px solid #eee', background: '#f9f9f9' }}>
      <td style={{ padding: '4px 8px' }}>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={{ width: '100%', padding: 4 }} />
      </td>
      <td style={{ padding: '4px 8px' }}>
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} style={{ width: '100%', padding: 4 }} />
      </td>
      <td style={{ padding: '4px 8px' }}>
        <input value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: '100%', padding: 4 }} />
      </td>
      <td style={{ padding: '4px 8px' }}><StatusPill status={status} /></td>
      <td style={{ padding: '4px 8px' }}>
        <input value={venmo} onChange={(e) => setVenmo(e.target.value)} style={{ width: '100%', padding: 4 }} />
      </td>
      <td style={{ padding: '4px 8px' }}>
        <select value={role} onChange={(e) => setRole(e.target.value)} style={{ padding: 4 }}>
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
      </td>
      <td style={{ padding: '4px 8px' }}>
        <select value={active} onChange={(e) => setActive(Number(e.target.value))} style={{ padding: 4 }}>
          <option value={1}>Yes</option>
          <option value={0}>No</option>
        </select>
      </td>
      <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>
        <button className="btn btn-primary" onClick={() => onSave({ display_name: displayName, full_name: fullName, email, venmo_handle: venmo, role, is_active: active })} disabled={saving} style={{ padding: '4px 10px', fontSize: 12, marginRight: 4 }}>
          {saving ? '...' : 'Save'}
        </button>
        <button className="btn btn-secondary" onClick={onCancel} disabled={saving} style={{ padding: '4px 10px', fontSize: 12 }}>Cancel</button>
      </td>
    </tr>
  );
}
