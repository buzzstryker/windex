import { useEffect, useMemo, useState } from 'react';
import {
  DuplicatePlayerEmailError,
  invitePlayer,
  type GroupAssignment,
  type InvitePlayerResponse,
} from '../api/playerAdmin';
import type { Group } from '../types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface AddPlayerModalProps {
  open: boolean;
  groups: Group[];
  onClose: () => void;
  onSuccess: (result: InvitePlayerResponse) => void;
}

/**
 * Super-admin-only modal for the unified "Add Player" flow.
 *
 * Captures display name, email, optional invite, and a per-group role for
 * each selected group, then calls the invite-player Edge Function.
 *
 * Duplicate-email (409) responses are translated into DuplicatePlayerEmailError
 * by the API layer; we surface a "View existing player" link in that case.
 */
export function AddPlayerModal({ open, groups, onClose, onSuccess }: AddPlayerModalProps) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [sendInvite, setSendInvite] = useState(true);
  // groupId -> role; presence in this map = "selected".
  const [assignments, setAssignments] = useState<Record<string, 'admin' | 'member'>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateExistingId, setDuplicateExistingId] = useState<string | null>(null);

  // Reset state when the modal closes so reopening yields a clean form.
  useEffect(() => {
    if (!open) {
      setDisplayName('');
      setEmail('');
      setSendInvite(true);
      setAssignments({});
      setBusy(false);
      setError(null);
      setDuplicateExistingId(null);
    }
  }, [open]);

  // Esc-to-cancel, matches ConfirmModal pattern.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  const trimmedName = displayName.trim();
  const trimmedEmail = email.trim();
  const emailValid = EMAIL_RE.test(trimmedEmail);
  const canSubmit = !busy && trimmedName.length > 0 && emailValid;

  const sortedGroups = useMemo(
    () => [...groups].sort((a, b) => a.name.localeCompare(b.name)),
    [groups]
  );

  const toggleGroup = (groupId: string) => {
    setAssignments((prev) => {
      const next = { ...prev };
      if (groupId in next) delete next[groupId];
      else next[groupId] = 'member';
      return next;
    });
  };

  const setRole = (groupId: string, role: 'admin' | 'member') => {
    setAssignments((prev) => ({ ...prev, [groupId]: role }));
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setDuplicateExistingId(null);

    const group_assignments: GroupAssignment[] = Object.entries(assignments).map(
      ([group_id, role]) => ({ group_id, role })
    );

    try {
      const result = await invitePlayer({
        display_name: trimmedName,
        email: trimmedEmail,
        send_invite: sendInvite,
        group_assignments,
      });
      onSuccess(result);
    } catch (e) {
      if (e instanceof DuplicatePlayerEmailError) {
        setDuplicateExistingId(e.existingPlayerId);
        setError(`A player with email ${trimmedEmail} already exists.`);
      } else {
        setError(e instanceof Error ? e.message : 'Failed to create player');
      }
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-player-modal-title"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 8,
          maxWidth: 560,
          width: '100%',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 20px',
            background: '#f5f5f5',
            borderBottom: '1px solid #e0e0e0',
          }}
        >
          <h2 id="add-player-modal-title" style={{ margin: 0, fontSize: '1.1rem', color: '#1a1a1a' }}>
            Add Player
          </h2>
        </div>

        <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
          <div style={{ marginBottom: 14 }}>
            <label htmlFor="ap-name" style={labelStyle}>Display name *</label>
            <input
              id="ap-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              style={inputStyle}
              disabled={busy}
              autoFocus
            />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label htmlFor="ap-email" style={labelStyle}>Email *</label>
            <input
              id="ap-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{
                ...inputStyle,
                borderColor: trimmedEmail && !emailValid ? '#c62828' : '#ccc',
              }}
              disabled={busy}
            />
            {trimmedEmail && !emailValid && (
              <div style={{ color: '#c62828', fontSize: 12, marginTop: 4 }}>
                Invalid email format
              </div>
            )}
          </div>

          <div style={{ marginBottom: 18 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: busy ? 'default' : 'pointer' }}>
              <input
                type="checkbox"
                checked={sendInvite}
                onChange={(e) => setSendInvite(e.target.checked)}
                disabled={busy}
              />
              <span>Send invite email now</span>
            </label>
            <div style={{ fontSize: 12, color: '#666', marginTop: 4, marginLeft: 24 }}>
              Sends an OTP-style sign-in email via Supabase. If an auth user already
              exists for this email, the invite is skipped — the trigger added in
              migration 020 links them automatically on next sign-in.
            </div>
          </div>

          <div>
            <div style={labelStyle}>Group assignments</div>
            {sortedGroups.length === 0 ? (
              <div style={{ fontSize: 13, color: '#666' }}>No groups available.</div>
            ) : (
              <div
                style={{
                  border: '1px solid #ddd',
                  borderRadius: 4,
                  maxHeight: 240,
                  overflowY: 'auto',
                }}
              >
                {sortedGroups.map((g) => {
                  const selected = g.id in assignments;
                  const role = assignments[g.id] ?? 'member';
                  return (
                    <div
                      key={g.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        padding: '8px 10px',
                        borderBottom: '1px solid #eee',
                        background: selected ? '#f0f7ff' : 'transparent',
                      }}
                    >
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          flex: 1,
                          cursor: busy ? 'default' : 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleGroup(g.id)}
                          disabled={busy}
                        />
                        <span>{g.name}</span>
                      </label>
                      {selected && (
                        <select
                          value={role}
                          onChange={(e) => setRole(g.id, e.target.value as 'admin' | 'member')}
                          disabled={busy}
                          style={{ padding: '2px 6px', fontSize: 13 }}
                        >
                          <option value="member">member</option>
                          <option value="admin">admin</option>
                        </select>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>
              {Object.keys(assignments).length} group{Object.keys(assignments).length === 1 ? '' : 's'} selected
            </div>
          </div>

          {error && (
            <div
              role="alert"
              style={{
                marginTop: 16,
                padding: '10px 12px',
                background: '#ffebee',
                color: '#c62828',
                border: '1px solid #f5c6c2',
                borderRadius: 4,
                fontSize: 13,
              }}
            >
              {error}
              {duplicateExistingId && (
                <div style={{ marginTop: 6 }}>
                  Existing player id: <code>{duplicateExistingId}</code>
                </div>
              )}
            </div>
          )}
        </div>

        <div
          style={{
            padding: '12px 20px',
            background: '#fafafa',
            borderTop: '1px solid #e0e0e0',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="btn"
            style={{
              background: '#0d47a1',
              color: '#fff',
              opacity: canSubmit ? 1 : 0.6,
            }}
          >
            {busy ? 'Creating…' : 'Create Player'}
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 6,
  color: '#1a1a1a',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  borderRadius: 4,
  border: '1px solid #ccc',
  fontSize: 14,
};
