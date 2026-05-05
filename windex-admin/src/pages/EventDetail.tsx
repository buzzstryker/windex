import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { getEvent } from '../api/events';
import type { EventDetail as EventDetailType } from '../types';

export function EventDetail() {
  const { eventId } = useParams<{ eventId: string }>();
  const [event, setEvent] = useState<EventDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!eventId) return;
    setLoading(true);
    setError(null);
    getEvent(eventId)
      .then(setEvent)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load event'))
      .finally(() => setLoading(false));
  }, [eventId]);

  if (!eventId) return <ErrorState message="Missing event ID" />;
  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;
  if (!event) return <EmptyState message="Event not found." />;

  return (
    <>
      <PageHeader
        title={`Event ${event.id.slice(0, 8)}`}
        subtitle={`${event.round_date} · ${event.source_app ?? '—'}`}
        action={
          <>
            <Link to={`/events/${eventId}/edit`} className="btn btn-primary" style={{ marginRight: 8 }}>Edit / override</Link>
            <Link to="/events" className="btn btn-secondary">Back to list</Link>
          </>
        }
      />
      <div className="card">
        <h2>Source &amp; status</h2>
        <p><strong>External event ID</strong>: {event.external_event_id ?? '—'}</p>
        <p><strong>Source app</strong>: {event.source_app ?? '—'}</p>
        <p><strong>Status</strong>: <StatusBadge status={event.status} /></p>
        {event.status === 'partial_unresolved_players' && (event.unresolved_player_count ?? 0) > 0 && (
          <p><strong>Unresolved players</strong>: {event.unresolved_player_count} player point row(s) were skipped (source identity not mapped).</p>
        )}
        <p><strong>Attribution</strong>: <StatusBadge status={event.attribution_status ?? 'attributed'} /></p>
        {event.attribution_status === 'pending_attribution' && (
          <p>This event needs group/season assignment. <Link to="/review/attribution">Resolve in Attribution review</Link></p>
        )}
        {event.validation_errors?.length ? (
          <p><strong>Validation errors</strong>: {event.validation_errors.join('; ')}</p>
        ) : null}
        {event.mapping_issues?.length ? (
          <p><strong>Mapping issues</strong>: {event.mapping_issues.join('; ')} <Link to="/review/player-mapping">Resolve in Player Mapping</Link></p>
        ) : null}
      </div>
      {event.results && event.results.length > 0 && (
        <div className="card">
          <h2>Results</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Player</th><th>Points (effective)</th><th>Override &amp; reason</th><th>Result type</th></tr>
              </thead>
              <tbody>
                {event.results.map((r) => {
                  const effective = r.score_override != null ? r.score_override : r.score_value;
                  const hasOverride = r.score_override != null;
                  return (
                    <tr key={r.player_id}>
                      <td>{r.player_name ?? r.player_id.slice(0, 8)}</td>
                      <td>
                        {effective}
                        {hasOverride && r.score_value !== effective && (
                          <span style={{ fontSize: 12, color: '#666', marginLeft: 6 }}>(points before override: {r.score_value})</span>
                        )}
                      </td>
                      <td>
                        {hasOverride ? (
                          <span>
                            <span style={{ color: '#e65100', fontWeight: 600 }}>{r.score_override}</span>
                            {r.override_reason && (
                              <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>{r.override_reason}</div>
                            )}
                            {(r.override_actor || r.override_at) && (
                              <div style={{ fontSize: 11, color: '#888', marginTop: 1 }}>
                                {[r.override_actor, r.override_at ? new Date(r.override_at).toLocaleString() : null].filter(Boolean).join(' · ')}
                              </div>
                            )}
                          </span>
                        ) : '—'}
                      </td>
                      <td>{r.result_type ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="card">
        <h2>Actions</h2>
        <p>
          <Link to="/review/attribution">Attribution review</Link>
          {' · '}
          <Link to="/review/player-mapping">{event.status === 'partial_unresolved_players' ? 'Player mapping (resolve skipped players)' : 'Player mapping'}</Link>
          {' · '}
          <Link to={`/events/${eventId}/edit`}>Edit round / override</Link>
        </p>
      </div>
    </>
  );
}
