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
  adminUpdateUserEmail,
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

// ─── Status column ────────────────────────────────────────────────────────
// Three-state derivation from players.user_id + the get_players_auth_status
// RPC. Returns null when we don't have enough info yet (RPC still loading
// for a linked player). The "not invited" state is derivable from the row
// alone, so it renders immediately.
type StatusKey = 'not_invited' | 'invited' | 'signed_in' | 'retired';

function deriveStatus(
  player: PlayerWithMembership,
  authStatus: PlayerAuthStatus | null
): StatusKey | null {
  if (player.retired_at) return 'retired';
  if (!player.user_id) return 'not_invited';
  if (!authStatus) return null;
  return authStatus.has_signed_in ? 'signed_in' : 'invited';
}

const STATUS_PILL: Record<StatusKey, { label: string; color: string; bg: string; border: string }> = {
  not_invited: { label: 'not invited', color: '#616161', bg: '#f5f5f5', border: '#e0e0e0' },
  invited:     { label: 'invited',     color: '#f57c00', bg: '#fff8e1', border: '#ffe0b2' },
  signed_in:   { label: 'signed in',   color: '#2e7d32', bg: '#e8f5e9', border: '#a5d6a7' },
  retired:     { label: 'retired',     color: '#616161', bg: '#eeeeee', border: '#bdbdbd' },
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
  const [tab, setTab] = useState<'active' | 'retired'>('active');
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
  // Drives the Status pill (invited vs signed in); empty until the RPC
  // resolves, in which case the pill renders "—" until truth arrives.
  const [authStatus, setAuthStatus] = useState<Map<string, PlayerAuthStatus>>(new Map());
  // First-invite flow state (send-invite Edge Function). Players who were
  // invited but haven't signed in self-serve at windexgolf.com/login — there
  // is no admin re-send.
  const [inviteTarget, setInviteTarget] = useState<PlayerWithMembership | null>(null);
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  // Retire / unretire flow (migration 029). Single-axis: only retired_at is
  // written; is_active is left untouched so history/standings stay correct.
  const [retireTarget, setRetireTarget] = useState<PlayerWithMembership | null>(null);
  const [retireMode, setRetireMode] = useState<'retire' | 'unretire'>('retire');
  const [retiring, setRetiring] = useState(false);
  const [retireError, setRetireError] = useState<string | null>(null);

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
      const list = await listPlayersWithMembership(groupId, { retired: tab === 'retired' });
      setPlayers(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [groupId, tab]);

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
      // Non-email player fields. Email is handled separately below because it
      // is the OTP login identity, not just a column.
      await updatePlayer(p.id, {
        display_name: fields.display_name,
        full_name: fields.full_name || null,
        venmo_handle: fields.venmo_handle || null,
        is_active: fields.is_active,
      });
      await updateMembership(p.membership.id, {
        role: fields.role,
        is_active: fields.is_active,
      });

      // Email change: route a LINKED player through admin-update-user-email so
      // auth.users.email changes too (and players.email is synced across all of
      // that user's rows). A not-yet-invited player has no login identity, so
      // just write the players.email column directly. Real function errors
      // (403 / 404 / 409 / invalid email) surface via the catch below.
      const newEmail = fields.email.trim();
      const oldEmail = (p.email ?? '').trim();
      if (newEmail !== oldEmail) {
        if (p.user_id) {
          await adminUpdateUserEmail(p.id, newEmail);
        } else {
          await updatePlayer(p.id, { email: newEmail || null });
        }
      }

      setSaveMsg('Saved');
      setEditingId(null);
      load();
      loadAuthStatus();
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
      setInviteTarget(null);
      load();
      loadAuthStatus(); // refresh per-row state so the Status pill reflects server truth
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

  const handleConfirmRetire = async () => {
    if (!retireTarget) return;
    setRetiring(true);
    setRetireError(null);
    try {
      await updatePlayer(retireTarget.id, {
        retired_at: retireMode === 'retire' ? new Date().toISOString() : null,
      });
      setToast(
        retireMode === 'retire'
          ? `${retireTarget.display_name} retired — hidden from operational lists; scored rounds remain in standings.`
          : `${retireTarget.display_name} unretired — back in operational lists.`
      );
      setRetireTarget(null);
      load();
    } catch (e) {
      setRetireError(e instanceof Error ? e.message : 'Failed to update retirement');
    } finally {
      setRetiring(false);
    }
  };

  const modalTitle = 'Send invite';
  const modalConfirmLabel = 'Send invite';

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

      {groupId && (
        <div className="card" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className={tab === 'active' ? 'btn btn-primary' : 'btn btn-secondary'}
            onClick={() => { setTab('active'); setEditingId(null); }}
            style={{ padding: '6px 14px' }}
          >
            Active
          </button>
          <button
            className={tab === 'retired' ? 'btn btn-primary' : 'btn btn-secondary'}
            onClick={() => { setTab('retired'); setEditingId(null); }}
            style={{ padding: '6px 14px' }}
          >
            Retired
          </button>
        </div>
      )}

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

      <ConfirmModal
        open={retireTarget !== null}
        title={retireMode === 'retire' ? 'Retire player' : 'Unretire player'}
        confirmLabel={retireMode === 'retire' ? 'Retire' : 'Unretire'}
        busy={retiring}
        errorMessage={retireError}
        onCancel={() => { setRetireTarget(null); setRetireError(null); }}
        onConfirm={handleConfirmRetire}
      >
        {retireTarget && retireMode === 'retire' && (
          <div style={{ fontSize: 14, lineHeight: 1.5 }}>
            <p style={{ margin: 0 }}>
              Retire <strong>{retireTarget.display_name}</strong>?
            </p>
            <p style={{ margin: '12px 0 0', color: '#666', fontSize: 13 }}>
              They will be hidden from operational lists (Players, group
              pickers, Add Round) but their scored rounds remain in standings.
              You can unretire them anytime from the Retired tab.
            </p>
          </div>
        )}
        {retireTarget && retireMode === 'unretire' && (
          <div style={{ fontSize: 14, lineHeight: 1.5 }}>
            <p style={{ margin: 0 }}>
              Unretire <strong>{retireTarget.display_name}</strong>? They will
              reappear in operational lists and pickers.
            </p>
          </div>
        )}
      </ConfirmModal>

      {toast && <ConfirmToast message={toast} onClose={() => setToast(null)} duration={5000} />}

      {loading && <LoadingSpinner />}
      {error && <ErrorState message={error} onRetry={load} />}
      {saveMsg && <div style={{ padding: '8px 16px', margin: '8px 0', background: saveMsg === 'Saved' ? '#e8f5e9' : '#ffebee', borderRadius: 4 }}>{saveMsg}</div>}

      {!loading && groupId && players.length === 0 && (
        <EmptyState message={tab === 'retired' ? 'No retired players in this group.' : 'No players in this group.'} />
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
                      tab={tab}
                      authStatus={authStatus.get(p.id) ?? null}
                      onEdit={() => { setEditingId(p.id); setSaveMsg(null); }}
                      onSendInvite={() => { setInviteError(null); setInviteTarget(p); }}
                      onRetire={() => { setRetireMode('retire'); setRetireError(null); setRetireTarget(p); }}
                      onUnretire={() => { setRetireMode('unretire'); setRetireError(null); setRetireTarget(p); }}
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
  tab,
  authStatus,
  onEdit,
  onSendInvite,
  onRetire,
  onUnretire,
}: {
  player: PlayerWithMembership;
  isSuperAdmin: boolean;
  tab: 'active' | 'retired';
  authStatus: PlayerAuthStatus | null;
  onEdit: () => void;
  onSendInvite: () => void;
  onRetire: () => void;
  onUnretire: () => void;
}) {
  const linked = p.user_id !== null && p.user_id !== undefined;
  const emailOk = hasValidEmail(p.email);
  const inviteDisabledReason = !emailOk
    ? (p.email ? 'Email is invalid' : 'Add an email first')
    : null;

  // Invite affordance: only for never-invited players (no user_id) on the
  // active tab. Invited-but-not-signed-in players self-serve sign-in at
  // windexgolf.com/login — admins no longer re-send. Never on the Retired tab.
  const showSendInvite = isSuperAdmin && !linked && tab === 'active';

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
        {isSuperAdmin && tab === 'active' && (
          <button
            className="btn btn-secondary"
            onClick={onRetire}
            style={{ padding: '4px 10px', fontSize: 12, marginRight: 4, color: '#c62828', borderColor: '#c62828' }}
          >
            Retire
          </button>
        )}
        {isSuperAdmin && tab === 'retired' && (
          <button
            className="btn btn-secondary"
            onClick={onUnretire}
            style={{ padding: '4px 10px', fontSize: 12, marginRight: 4 }}
          >
            Unretire
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
