import { useEffect, useState, useCallback } from 'react';
import { PageHeader } from '../components/PageHeader';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { listGroups } from '../api/groups';
import {
  listPlayersWithMembership, updatePlayer, updateMembership,
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

export function Players() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState('');
  const [players, setPlayers] = useState<PlayerWithMembership[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    listGroups().then(setGroups).catch(() => {});
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
    const userId = getCurrentUserId();
    if (!userId) { setSaveMsg('Not signed in'); return; }
    setSaving(true);
    setSaveMsg(null);
    try {
      await updatePlayer(p.id, userId, {
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

  return (
    <>
      <PageHeader title="Players" subtitle="View and manage player data by group." />

      <div className="card">
        <div className="form-section" style={{ maxWidth: 300 }}>
          <label htmlFor="pl-group">Group</label>
          <select id="pl-group" value={groupId} onChange={(e) => { setGroupId(e.target.value); setEditingId(null); }}>
            <option value="">Select group...</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
      </div>

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
                  : <DisplayRow key={p.id} player={p} onEdit={() => { setEditingId(p.id); setSaveMsg(null); }} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function DisplayRow({ player: p, onEdit }: { player: PlayerWithMembership; onEdit: () => void }) {
  return (
    <tr style={{ borderBottom: '1px solid #eee' }}>
      <td style={{ padding: '6px 10px', fontWeight: 600 }}>{p.display_name}</td>
      <td style={{ padding: '6px 10px', color: '#666' }}>{p.full_name ?? '—'}</td>
      <td style={{ padding: '6px 10px', color: '#666' }}>{p.email ?? '—'}</td>
      <td style={{ padding: '6px 10px', color: '#666' }}>{p.venmo_handle ?? '—'}</td>
      <td style={{ padding: '6px 10px' }}>{p.membership.role}</td>
      <td style={{ padding: '6px 10px' }}>
        <span style={{ color: p.membership.is_active ? '#2e7d32' : '#c62828', fontWeight: 600 }}>
          {p.membership.is_active ? 'Yes' : 'No'}
        </span>
      </td>
      <td style={{ padding: '6px 10px' }}>
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
