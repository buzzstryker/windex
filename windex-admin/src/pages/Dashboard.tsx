import React, { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { DataTable } from '../components/DataTable';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { listEvents } from '../api/events';
import { listAttributionQueue } from '../api/attribution';
import { listPlayerMappingQueue } from '../api/playerMapping';
import { resetAndSeed, importNewRounds, type SeedProgress } from '../api/adminSeed';
import type { EventSummary } from '../types';

export function Dashboard() {
  const navigate = useNavigate();
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [attributionCount, setAttributionCount] = useState<number>(0);
  const [mappingCount, setMappingCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [partialEventCount, setPartialEventCount] = useState<number>(0);
  const [seedProgress, setSeedProgress] = useState<SeedProgress | null>(null);
  const [seeding, setSeeding] = useState(false);

  const handleResetAndSeed = useCallback(async () => {
    if (!window.confirm('This will DELETE all data and re-import from Glide. Continue?')) return;
    setSeeding(true);
    setSeedProgress({ step: 'Starting...', done: false });
    try {
      await resetAndSeed((p) => setSeedProgress(p));
      load();
    } catch (e: unknown) {
      setSeedProgress({ step: `Error: ${e instanceof Error ? e.message : String(e)}`, done: true });
    } finally {
      setSeeding(false);
    }
  }, []);

  const handleImportNew = useCallback(async () => {
    setSeeding(true);
    setSeedProgress({ step: 'Starting...', done: false });
    try {
      await importNewRounds((p) => setSeedProgress(p));
      load();
    } catch (e: unknown) {
      setSeedProgress({ step: `Error: ${e instanceof Error ? e.message : String(e)}`, done: true });
    } finally {
      setSeeding(false);
    }
  }, []);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [evts, attr, map] = await Promise.allSettled([
        listEvents({}),
        listAttributionQueue(),
        listPlayerMappingQueue(),
      ]);
      if (evts.status === 'fulfilled') {
        const list = evts.value;
        setEvents(list.slice(0, 15));
        setPartialEventCount(list.filter((e) => e.status === 'partial_unresolved_players').length);
      } else {
        setEvents([]);
        setPartialEventCount(0);
      }
      if (attr.status === 'fulfilled') setAttributionCount(attr.value.length);
      else setAttributionCount(0);
      if (map.status === 'fulfilled') setMappingCount(map.value.length);
      else setMappingCount(0);
      if (evts.status === 'rejected' && attr.status === 'rejected' && map.status === 'rejected')
        setError([evts.reason?.message, attr.reason?.message, map.reason?.message].filter(Boolean)[0] ?? 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  const columns = [
    { key: 'id', label: 'Event', render: (r: EventSummary) => r.external_event_id || r.id.slice(0, 8) },
    { key: 'source_app', label: 'Source app', render: (r: EventSummary) => r.source_app ?? '—' },
    { key: 'round_date', label: 'Date' },
    { key: 'group_name', label: 'Group', render: (r: EventSummary) => r.group_name ?? r.group_id?.slice(0, 8) ?? '—' },
    { key: 'status', label: 'Status', render: (r: EventSummary) => <StatusBadge status={r.status} /> },
  ];

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Operational snapshot" />
      <div className="card">
        <h2>Summary</h2>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
          <div><strong>Showing latest 15 events</strong></div>
          <div><strong>Pending attribution</strong>: {attributionCount} <Link to="/review/attribution">Review</Link></div>
          <div><strong>Pending player mapping</strong>: {mappingCount} <Link to="/review/player-mapping">Review</Link></div>
        </div>
      </div>
      <div className="card">
        <h2>Attention required</h2>
        <ul className="attention-list">
          <li>
            <span>Attribution review queue</span>
            <Link to="/review/attribution">{attributionCount} item(s)</Link>
          </li>
          <li>
            <span>Player mapping queue</span>
            <Link to="/review/player-mapping">{mappingCount} item(s)</Link>
          </li>
          {partialEventCount > 0 && (
            <li>
              <span>Events with unresolved players</span>
              <Link to="/events?status=partial_unresolved_players">{partialEventCount} event(s)</Link>
            </li>
          )}
        </ul>
      </div>
      <div className="card">
        <h2>Recent events</h2>
        {events.length === 0 ? (
          <p className="empty-state">No events yet. <Link to="/events/new">Enter a round</Link> or wait for API ingestion.</p>
        ) : (
          <DataTable
            columns={columns}
            data={events}
            getRowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/events/${r.id}`)}
          />
        )}
        <p style={{ marginTop: 12 }}>
          <Link to="/events" className="btn btn-secondary" style={{ display: 'inline-block' }}>View all events</Link>
        </p>
      </div>
      <div className="card" style={{ borderTop: '2px solid #c62828' }}>
        <h2>Dev Tools</h2>
        <p style={{ marginBottom: 12, color: '#666' }}>
          Clear all data and re-import from Glide ODS export. This is destructive.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary"
            onClick={handleImportNew}
            disabled={seeding}
          >
            {seeding ? 'Importing...' : 'Import New Rounds'}
          </button>
          <button
            className="btn btn-primary"
            style={{ background: '#c62828' }}
            onClick={handleResetAndSeed}
            disabled={seeding}
          >
            Reset & Import All
          </button>
        </div>
        {seedProgress && (
          <div style={{ marginTop: 12, padding: 12, background: '#f5f5f5', borderRadius: 4, fontFamily: 'monospace', fontSize: 13 }}>
            <div>{seedProgress.step}</div>
            {seedProgress.roundsOk != null && (
              <div style={{ marginTop: 4, color: '#666' }}>
                OK: {seedProgress.roundsOk} | Failed: {seedProgress.roundsFailed}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
