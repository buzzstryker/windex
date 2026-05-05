import React, { useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { DataTable } from '../components/DataTable';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { ConfirmToast } from '../components/ConfirmToast';
import { listAttributionQueue, resolveAttribution } from '../api/attribution';
import { listGroups, listSeasons } from '../api/groups';
import type { AttributionItem, Group, Season } from '../types';
import { seasonLabel } from '../types';

export function AttributionReview() {
  const [items, setItems] = useState<AttributionItem[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [selected, setSelected] = useState<AttributionItem | null>(null);
  const [groupId, setGroupId] = useState('');
  const [seasonId, setSeasonId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [queueData, groupsData, seasonsData] = await Promise.all([
        listAttributionQueue(),
        listGroups(),
        listSeasons(),
      ]);
      setItems(queueData);
      setGroups(groupsData);
      setSeasons(seasonsData);
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

  const seasonsForGroup = groupId ? seasons.filter((s) => s.group_id === groupId) : seasons;

  const handleResolve = async () => {
    if (!selected || !groupId) return;
    setSaving(true);
    try {
      await resolveAttribution(selected.id, { group_id: groupId, season_id: seasonId || null });
      setToast('Attribution resolved.');
      setSelected(null);
      setGroupId('');
      setSeasonId('');
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
    { key: 'event_id', label: 'Event', render: (r: AttributionItem) => r.event_id?.slice(0, 8) ?? r.id.slice(0, 8) },
    { key: 'source_app', label: 'Source app', render: (r: AttributionItem) => r.source_app ?? '—' },
    { key: 'round_date', label: 'Played date' },
    { key: 'status', label: 'Status' },
  ];

  return (
    <>
      <PageHeader title="Attribution review" subtitle="Resolve events that need group/season assignment" />
      {toast && <ConfirmToast message={toast} onClose={() => setToast(null)} />}
      <div className="card">
        {items.length === 0 ? (
          <EmptyState
            message="No unresolved attribution items."
            detail="When events are ingested without a season, they appear here. Assign group and season to resolve."
          />
        ) : (
          <>
            <DataTable
              columns={columns}
              data={items}
              getRowKey={(r) => r.id}
              onRowClick={(r) => { setSelected(r); setGroupId(r.group_id ?? ''); setSeasonId(r.season_id ?? ''); }}
              selectedRowKey={selected?.id ?? null}
            />
            {selected && (
              <div style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid #eee' }}>
                <h3>Resolve: {selected.event_id?.slice(0, 8)}</h3>
                <p>Source app: {selected.source_app ?? '—'} · Date: {selected.round_date}</p>
                <div className="form-section">
                  <label>Group (required)</label>
                  {groups.length > 0 ? (
                    <select value={groupId} onChange={(e) => { setGroupId(e.target.value); setSeasonId(''); }} style={{ minWidth: 200, padding: 6 }}>
                      <option value="">Select group…</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>{g.name}</option>
                      ))}
                    </select>
                  ) : (
                    <input value={groupId} onChange={(e) => setGroupId(e.target.value)} placeholder="Group ID" />
                  )}
                </div>
                <div className="form-section">
                  <label>Season (optional)</label>
                  {seasonsForGroup.length > 0 ? (
                    <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)} style={{ minWidth: 200, padding: 6 }}>
                      <option value="">None</option>
                      {seasonsForGroup.map((s) => (
                        <option key={s.id} value={s.id}>{seasonLabel(s)}</option>
                      ))}
                    </select>
                  ) : (
                    <input value={seasonId} onChange={(e) => setSeasonId(e.target.value)} placeholder="Season ID" />
                  )}
                </div>
                <div className="form-actions">
                  <button type="button" className="btn btn-primary" onClick={handleResolve} disabled={saving || !groupId}>
                    {saving ? 'Saving…' : 'Submit resolution'}
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => { setSelected(null); setGroupId(''); setSeasonId(''); }}>Cancel</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
