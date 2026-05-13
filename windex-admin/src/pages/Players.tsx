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
  type PlayerWithMembership,
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
  // Send-invite flow state.
  const [inviteTarget, setInviteTarget] = useState<PlayerWithMembership | null>(null);
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  useEffect(() => {
    listGroups().then(setGroups).catch(() => {});
    isCurrentUserSuperAdmin().then(setIsSuperAdmin).catch(() => setIsSuperAdmin(false));
  }, []);

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
    // Sign-in check: RLS still requires an authenticated session, but we no
    // longer need the user_id for the PATCH WHERE clause — RLS handles the
    // super-admin / owning-user gate.
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
      const res = await sendInvite(inviteTarget.id);
      // Compose a status line based on what actually happened.
      let line: string;
      if (res.already_had_auth) {
        line = `Auth account already existed for ${inviteTarget.email}; linked without re-emailing.`;
      } else if (res.invite_sent && res.linked) {
        line = `Invite sent to ${inviteTarget.email}.`;
      } else if (res.invite_sent && !res.linked) {
        // Trigger didn't link — possible email casing/whitespace mismatch.
        // Tell the admin so they don't assume "linked" silently.
        line = `Invite sent to ${inviteTarget.email}, but auto-link didn't fire. Refresh and check the player's email.`;
      } else {
        line = `Invite request returned without change. Refresh and verify.`;
      }
      setToast(line);
      setInviteTarget(null);
      load(); // refresh row state so button → badge transition is visible
    } catch (e) {
      if (e instanceof PlayerAlreadyLinkedError) {
        setInviteError('This player is already linked to an auth user. Refresh the page.');
      } else {
        setInviteError(e instanceof Error ? e.message : 'Failed to send invite');
      }
    } finally {
      setInviting(false);
    }
  };

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
            // Refresh members if a group is selected; otherwise the list stays empty
            // (selection-driven page) and the new player will appear once selected.
            if (groupId) load();
          }}
        />
      )}

      <ConfirmModal
        open={inviteTarget !== null}
        title="Send invite"
        confirmLabel="Send invite"
        busy={inviting}
        errorMessage={inviteError}
        onCancel={() => { setInviteTarget(null); setInviteError(null); }}
        onConfirm={handleConfirmInvite}
      >
        {inviteTarget && (
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
                <th style={{ padding: '8px 10px' }}>Venmo</th>
                <th style={{ padding: '8px 10px' }}>Role</th>
                <th style={{ padding: '8px 10px' }}>Active</th>
                <th style={{ padding: '8px 10px' }}></th>
              </tr>
            </thead>
            <tbody>
              {players.map((p) => (
                editingId === p.id
                  ? <EditRow key={p.id} player={p} onSave={(f) => handleSave(p, f)} onCancel={() => setEditingId(null)} saving={saving} />
                  : <DisplayRow
                      key={p.id}
                      player={p}
                      isSuperAdmin={isSuperAdmin}
                      onEdit={() => { setEditingId(p.id); setSaveMsg(null); }}
                      onSendInvite={() => { setInviteError(null); setInviteTarget(p); }}
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
  onEdit,
  onSendInvite,
}: {
  player: PlayerWithMembership;
  isSuperAdmin: boolean;
  onEdit: () => void;
  onSendInvite: () => void;
}) {
  const linked = p.user_id !== null && p.user_id !== undefined;
  const emailOk = hasValidEmail(p.email);
  // Disabled-button tooltip explains why send is blocked.
  const inviteDisabledReason = !emailOk
    ? (p.email ? 'Email is invalid' : 'Add an email first')
    : null;

  return (
    <tr style={{ borderBottom: '1px solid #eee' }}>
      <td style={{ padding: '6px 10px', fontWeight: 600 }}>{p.display_name}</td>
      <td style={{ padding: '6px 10px', color: '#666' }}>{p.full_name ?? '—'}</td>
      <td style={{ padding: '6px 10px', color: '#666' }}>
        {p.email ?? '—'}
        {linked && (
          <span
            title="Linked to an auth.users row"
            style={{
              marginLeft: 8,
              padding: '1px 8px',
              fontSize: 11,
              fontWeight: 600,
              color: '#2e7d32',
              background: '#e8f5e9',
              border: '1px solid #a5d6a7',
              borderRadius: 10,
              whiteSpace: 'nowrap',
            }}
          >
            Invited ✓
          </span>
        )}
      </td>
      <td style={{ padding: '6px 10px', color: '#666' }}>{p.venmo_handle ?? '—'}</td>
      <td style={{ padding: '6px 10px' }}>{p.membership.role}</td>
      <td style={{ padding: '6px 10px' }}>
        <span style={{ color: p.membership.is_active ? '#2e7d32' : '#c62828', fontWeight: 600 }}>
          {p.membership.is_active ? 'Yes' : 'No'}
        </span>
      </td>
      <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
        {isSuperAdmin && !linked && (
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
        <button className="btn btn-secondary" onClick={onEdit} style={{ padding: '4px 10px', fontSize: 12 }}>Edit</button>
      </td>
    </tr>
  );
}

function EditRow({ player: p, onSave, onCancel, saving }: {
  player: PlayerWithMembership;
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
