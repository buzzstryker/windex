import React, { useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { DataTable } from '../components/DataTable';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { ConfirmToast } from '../components/ConfirmToast';
import { listPlayerMappingQueue, resolvePlayerMapping } from '../api/playerMapping';
import { listPlayers } from '../api/players';
import type { PlayerMappingItem, Player } from '../types';

export function PlayerMapping() {
  const [items, setItems] = useState<PlayerMappingItem[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [selected, setSelected] = useState<PlayerMappingItem | null>(null);
  const [playerId, setPlayerId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [queueData, playersData] = await Promise.all([
        listPlayerMappingQueue(),
        listPlayers(),
      ]);
      setItems(queueData);
      setPlayers(playersData);
      if (!queueData.find((i) => i.id === selected?.id)) setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load queue');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleResolve = async () => {
    if (!selected || !playerId) return;
    setSaving(true);
    try {
      await resolvePlayerMapping(selected.id, { player_id: playerId });
      setToast('Player mapping saved.');
      setSelected(null);
      setPlayerId('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to resolve');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  const columns = [
    { key: 'source_player_name', label: 'Source player name' },
    { key: 'source_app', label: 'Source app', render: (r: PlayerMappingItem) => r.source_app ?? '—' },
    { key: 'related_event_id', label: 'Related event', render: (r: PlayerMappingItem) => r.related_event_id?.slice(0, 8) ?? '—' },
    { key: 'status', label: 'Status' },
  ];

  return (
    <>
      <PageHeader title="Player mapping" subtitle="Map source players to Windex players" />
      {toast && <ConfirmToast message={toast} onClose={() => setToast(null)} />}
      <div className="card">
        {items.length === 0 ? (
          <EmptyState
            message="No unresolved player mapping items."
            detail="When a source player can’t be matched to a Windex player, they appear here. Resolve to map them for future ingestion."
          />
        ) : (
          <>
            <DataTable
              columns={columns}
              data={items}
              getRowKey={(r) => r.id}
              onRowClick={(r) => { setSelected(r); setPlayerId(r.candidate_players?.[0]?.id ?? ''); }}
              selectedRowKey={selected?.id ?? null}
            />
            {selected && (
              <div style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid #eee' }}>
                <h3>Map: {selected.source_player_name}</h3>
                <p>Source app: {selected.source_app ?? '—'} · Event: {selected.related_event_id?.slice(0, 8) ?? '—'}</p>
                <div className="form-section">
                  <label>Canonical player (required)</label>
                  {players.length > 0 ? (
                    <select
                      value={playerId}
                      onChange={(e) => setPlayerId(e.target.value)}
                      style={{ minWidth: 200, padding: 6 }}
                    >
                      <option value="">Select player…</option>
                      {players.map((p) => (
                        <option key={p.id} value={p.id}>{p.display_name} ({p.id})</option>
                      ))}
                    </select>
                  ) : (
                    <input value={playerId} onChange={(e) => setPlayerId(e.target.value)} placeholder="Player ID" />
                  )}
                  {selected.candidate_players?.length ? (
                    <p style={{ marginTop: 8, fontSize: 12, color: '#666' }}>
                      Suggestions: {selected.candidate_players.map((p) => (
                        <button key={p.id} type="button" onClick={() => setPlayerId(p.id)} style={{ marginRight: 8 }}>{p.name} ({p.id.slice(0, 8)})</button>
                      ))}
                    </p>
                  ) : null}
                </div>
                <div className="form-actions">
                  <button type="button" className="btn btn-primary" onClick={handleResolve} disabled={saving || !playerId}>
                    {saving ? 'Saving…' : 'Confirm mapping'}
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => { setSelected(null); setPlayerId(''); }}>Cancel</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
