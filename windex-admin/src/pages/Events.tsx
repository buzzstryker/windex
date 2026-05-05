import React, { useEffect, useState, useMemo } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { DataTable } from '../components/DataTable';
import { FilterBar } from '../components/FilterBar';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { listEvents } from '../api/events';
import { listGroups } from '../api/groups';
import { getAuthToken } from '../api/client';
import type { EventSummary, Group } from '../types';
import { seasonNameToYear } from '../types';

const SUPABASE_URL = (
  typeof import.meta.env !== 'undefined' && import.meta.env.VITE_LATE_ADD_API_URL
    ? import.meta.env.VITE_LATE_ADD_API_URL
    : 'https://ftmqzxykwcccocogkjhc.supabase.co/functions/v1'
).replace(/\/functions\/v1\/?$/, '');
const ANON_KEY =
  typeof import.meta.env !== 'undefined' && import.meta.env.VITE_SUPABASE_ANON_KEY
    ? import.meta.env.VITE_SUPABASE_ANON_KEY
    : null;

function restHeaders(): Record<string, string> {
  const token = getAuthToken() ?? ANON_KEY;
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(ANON_KEY ? { apikey: ANON_KEY } : {}),
  };
}

type SortKey = 'round_date' | 'total_game_points';
type SortDir = 'asc' | 'desc';

export function Events() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('round_date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const source = searchParams.get('source_app') ?? '';
  const status = searchParams.get('status') ?? '';
  const attributionFilter = searchParams.get('attribution_status') ?? '';
  const groupId = searchParams.get('group_id') ?? '';
  const fromDate = searchParams.get('from_date') ?? '';
  const toDate = searchParams.get('to_date') ?? '';

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const baseParams = {
        source_app: source || undefined,
        status: status || undefined,
        group_id: groupId || undefined,
        from_date: fromDate || undefined,
        to_date: toDate || undefined,
      };
      let evts: EventSummary[];
      if (attributionFilter === 'pending_attribution') {
        evts = await listEvents({ ...baseParams, attribution_status: 'pending_attribution' });
      } else if (attributionFilter === 'attributed_resolved') {
        const [attributed, resolved] = await Promise.all([
          listEvents({ ...baseParams, attribution_status: 'attributed' }),
          listEvents({ ...baseParams, attribution_status: 'attribution_resolved' }),
        ]);
        const byId = new Map<string, EventSummary>();
        [...attributed, ...resolved].forEach((e) => byId.set(e.id, e));
        evts = Array.from(byId.values());
      } else {
        evts = await listEvents(baseParams);
      }

      // Fetch total game points per round from PostgREST
      if (evts.length > 0) {
        try {
          const ids = evts.map((e) => e.id);
          const BATCH = 200;
          const totals = new Map<string, number>();
          for (let i = 0; i < ids.length; i += BATCH) {
            const batch = ids.slice(i, i + BATCH);
            const inList = batch.map((id) => `"${id}"`).join(',');
            const res = await fetch(
              `${SUPABASE_URL}/rest/v1/league_scores?league_round_id=in.(${inList})&select=league_round_id,score_value,score_override`,
              { headers: restHeaders() }
            );
            if (res.ok) {
              const scores: { league_round_id: string; score_value: number | null; score_override: number | null }[] = await res.json();
              for (const s of scores) {
                const pts = s.score_override ?? s.score_value ?? 0;
                totals.set(s.league_round_id, (totals.get(s.league_round_id) ?? 0) + Math.abs(pts));
              }
            }
          }
          evts = evts.map((e) => ({ ...e, total_game_points: totals.get(e.id) ?? 0 }));
        } catch {
          // Non-critical; leave total_game_points undefined
        }
      }

      setEvents(evts);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load events');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    listGroups().then(setGroups).catch(() => setGroups([]));
  }, []);

  useEffect(() => {
    load();
  }, [source, status, attributionFilter, groupId, fromDate, toDate]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  };

  const toggleSigEvent = async (e: React.MouseEvent, event: EventSummary) => {
    e.stopPropagation();
    const newVal = event.is_signature_event ? 0 : 1;
    const token = getAuthToken() ?? ANON_KEY;
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/league_rounds?id=eq.${encodeURIComponent(event.id)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(ANON_KEY ? { apikey: ANON_KEY } : {}),
        },
        body: JSON.stringify({ is_signature_event: newVal }),
      }
    );
    if (res.ok) {
      setEvents((prev) => prev.map((ev) => ev.id === event.id ? { ...ev, is_signature_event: newVal } : ev));
    }
  };

  const deleteRound = async (e: React.MouseEvent, event: EventSummary) => {
    e.stopPropagation();
    if (!window.confirm(`Delete round ${event.round_date}? This will remove the round and all its scores. This cannot be undone.`)) return;
    const token = getAuthToken() ?? ANON_KEY;
    const headers = {
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(ANON_KEY ? { apikey: ANON_KEY } : {}),
    };
    // Delete scores first (FK child), then the round
    await fetch(`${SUPABASE_URL}/rest/v1/league_scores?league_round_id=eq.${encodeURIComponent(event.id)}`, { method: 'DELETE', headers });
    const res = await fetch(`${SUPABASE_URL}/rest/v1/league_rounds?id=eq.${encodeURIComponent(event.id)}`, { method: 'DELETE', headers });
    if (res.ok) {
      setEvents((prev) => prev.filter((ev) => ev.id !== event.id));
    }
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'total_game_points' ? 'desc' : 'desc');
    }
  };

  const sortIndicator = (key: SortKey) =>
    sortKey === key ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

  const sortedEvents = useMemo(() => {
    const sorted = [...events];
    sorted.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'round_date') {
        cmp = a.round_date.localeCompare(b.round_date);
      } else if (sortKey === 'total_game_points') {
        cmp = (a.total_game_points ?? 0) - (b.total_game_points ?? 0);
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [events, sortKey, sortDir]);

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  const columns = [
    { key: 'id', label: 'Event ID', render: (r: EventSummary) => r.id.slice(0, 8) },
    {
      key: 'round_date',
      label: `Played date${sortIndicator('round_date')}`,
      render: (r: EventSummary) => r.round_date,
      headerProps: { onClick: () => toggleSort('round_date'), style: { cursor: 'pointer' } },
    },
    { key: 'group_name', label: 'Group', render: (r: EventSummary) => r.group_name ?? r.group_id?.slice(0, 8) ?? '—' },
    { key: 'season_name', label: 'Season', render: (r: EventSummary) => seasonNameToYear(r.season_name) },
    {
      key: 'total_game_points',
      label: `Game Pts${sortIndicator('total_game_points')}`,
      render: (r: EventSummary) => r.total_game_points != null ? Math.round(r.total_game_points) : '—',
      headerProps: { onClick: () => toggleSort('total_game_points'), style: { cursor: 'pointer' } },
    },
    { key: 'status', label: 'Status', render: (r: EventSummary) => <StatusBadge status={r.status} /> },
    {
      key: 'is_signature_event', label: 'Sig',
      render: (r: EventSummary) => (
        <button
          onClick={(e) => toggleSigEvent(e, r)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, padding: 0 }}
          title={r.is_signature_event ? 'Signature Event (click to unmark)' : 'Click to mark as Signature Event'}
        >
          {r.is_signature_event ? '\u2605' : '\u2606'}
        </button>
      ),
    },
    {
      key: 'delete', label: '',
      render: (r: EventSummary) => (
        <button
          onClick={(e) => deleteRound(e, r)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: '2px 6px', color: '#c62828' }}
          title="Delete round"
        >
          &#x2715;
        </button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Rounds"
        subtitle="All rounds (API-ingested and manual)"
        action={<Link to="/events/new" className="btn btn-primary">New round</Link>}
      />
      <FilterBar>
        <label>
          Group
          <select value={groupId} onChange={(e) => updateParam('group_id', e.target.value)}>
            <option value="">All</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </label>
        <label>
          Source app
          <select value={source} onChange={(e) => updateParam('source_app', e.target.value)}>
            <option value="">All</option>
            <option value="manual">manual</option>
            <option value="glide">glide</option>
          </select>
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => updateParam('status', e.target.value)}>
            <option value="">All</option>
            <option value="processed">Processed</option>
            <option value="partial_unresolved_players">Partial (unresolved players)</option>
          </select>
        </label>
        <label>
          From date
          <input type="date" value={fromDate} onChange={(e) => updateParam('from_date', e.target.value)} />
        </label>
        <label>
          To date
          <input type="date" value={toDate} onChange={(e) => updateParam('to_date', e.target.value)} />
        </label>
      </FilterBar>
      <div className="card">
        {sortedEvents.length === 0 ? (
          <EmptyState message="No rounds match the filters." action={<Link to="/events/new" className="btn btn-primary">Enter a round</Link>} />
        ) : (
          <DataTable
            columns={columns}
            data={sortedEvents}
            getRowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/events/${r.id}`)}
          />
        )}
      </div>
    </>
  );
}
