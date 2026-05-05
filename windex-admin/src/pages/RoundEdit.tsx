import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { FormSection } from '../components/FormSection';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { ConfirmToast } from '../components/ConfirmToast';
import { getEvent, updateEvent } from '../api/events';
import { listSeasons } from '../api/groups';
import type { EventDetail as EventDetailType, EventResult, Season } from '../types';
import { seasonLabel } from '../types';

export function RoundEdit() {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const [event, setEvent] = useState<EventDetailType | null>(null);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [roundDate, setRoundDate] = useState('');
  const [seasonId, setSeasonId] = useState('');
  const [results, setResults] = useState<EventResult[]>([]);
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideActor, setOverrideActor] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!eventId) return;
    getEvent(eventId)
      .then((e) => {
        setEvent(e);
        setRoundDate(e.round_date ?? '');
        setSeasonId(e.season_id ?? '');
        setResults(e.results ?? []);
        const firstOverride = (e.results ?? []).find((r) => r.score_override != null);
        if (firstOverride?.override_reason) setOverrideReason(firstOverride.override_reason);
        if (firstOverride?.override_actor) setOverrideActor(firstOverride.override_actor);
        if (e.group_id) listSeasons(e.group_id).then(setSeasons).catch(() => setSeasons([]));
        else setSeasons([]);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load event'))
      .finally(() => setLoading(false));
  }, [eventId]);

  const updateResult = (i: number, field: 'score_value' | 'score_override', value: number) => {
    setResults((r) => r.map((row, j) => (j === i ? { ...row, [field]: value } : row)));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!eventId || !event) return;
    setSaving(true);
    setError(null);
    try {
      const hasAnyOverride = results.some((r) => r.score_override != null);
      await updateEvent(eventId, {
        round_date: roundDate,
        season_id: seasonId || null,
        results: results.map((r) => ({
          player_id: r.player_id,
          score_value: r.score_value,
          score_override: r.score_override ?? null,
        })),
        ...(hasAnyOverride && {
          override_reason: overrideReason.trim() || undefined,
          override_actor: overrideActor.trim() || undefined,
        }),
      });
      setToast('Round updated.');
      navigate(`/events/${eventId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update round');
    } finally {
      setSaving(false);
    }
  };

  if (!eventId) return <ErrorState message="Missing event ID" />;
  if (loading) return <LoadingSpinner />;
  if (error && !event) return <ErrorState message={error} onRetry={() => window.location.reload()} />;
  if (!event) return null;

  return (
    <>
      <PageHeader title="Edit / override round" subtitle={`Event ${eventId.slice(0, 8)}`} />
      {toast && <ConfirmToast message={toast} onClose={() => setToast(null)} />}
      <div className="card">
        <form onSubmit={handleSubmit}>
          <FormSection title="Event metadata">
            <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>Current values are loaded from the event; changes are corrections. Standings are derived from the ledger after save.</p>
            <label>Played date</label>
            <input type="date" value={roundDate} onChange={(e) => setRoundDate(e.target.value)} />
            <label style={{ marginTop: 12 }}>Season (optional)</label>
            {seasons.length > 0 ? (
              <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)} style={{ maxWidth: 400 }}>
                <option value="">—</option>
                {seasons.map((s) => (
                  <option key={s.id} value={s.id}>{seasonLabel(s)}</option>
                ))}
              </select>
            ) : (
              <input value={seasonId} onChange={(e) => setSeasonId(e.target.value)} placeholder="Season ID" />
            )}
          </FormSection>
          <FormSection title="Results (override only when needed)">
            <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>Points = awarded point total (stored). Override = corrected point total that replaces it for standings. When you set an override, provide a reason below.</p>
            {results.some((r) => r.score_override != null) && (() => {
              const first = results.find((r) => r.score_override != null);
              return (first?.override_reason || first?.override_actor || first?.override_at) ? (
                <p style={{ fontSize: 12, color: '#666', marginBottom: 8, padding: 8, background: '#f5f5f5', borderRadius: 4 }}>
                  Existing override on this round: {[first?.override_reason, first?.override_actor && `by ${first.override_actor}`, first?.override_at && new Date(first.override_at).toLocaleString()].filter(Boolean).join(' · ')}
                </p>
              ) : null;
            })()}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, paddingBottom: 4, borderBottom: '1px solid #eee' }}>
              <span style={{ minWidth: 140, fontWeight: 600, fontSize: 12, color: '#555' }}>Player</span>
              <span style={{ width: 88, fontWeight: 600, fontSize: 12, color: '#555' }}>Points</span>
              <span style={{ width: 88, fontWeight: 600, fontSize: 12, color: '#555' }}>Override</span>
            </div>
            {results.map((row, i) => (
              <div key={row.player_id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <span style={{ minWidth: 140 }}>{row.player_name ?? row.player_id.slice(0, 8)}</span>
                <input
                  type="number"
                  value={row.score_value}
                  onChange={(e) => updateResult(i, 'score_value', Number(e.target.value))}
                  style={{ width: 88 }}
                  aria-label={`Points for ${row.player_name ?? row.player_id}`}
                />
                <input
                  type="number"
                  placeholder="—"
                  value={row.score_override ?? ''}
                  onChange={(e) => updateResult(i, 'score_override', e.target.value === '' ? 0 : Number(e.target.value))}
                  style={{ width: 88 }}
                  aria-label={`Override for ${row.player_name ?? row.player_id}`}
                />
              </div>
            ))}
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #eee' }}>
              <label style={{ display: 'block', fontWeight: 600, fontSize: 12, color: '#555', marginBottom: 4 }}>Override reason (required when any override value is set)</label>
              <input
                type="text"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="e.g. Points correction after review"
                style={{ maxWidth: 400, width: '100%' }}
                aria-label="Override reason"
              />
              <label style={{ display: 'block', fontWeight: 600, fontSize: 12, color: '#555', marginTop: 8, marginBottom: 4 }}>Override actor (optional; default: admin_ui)</label>
              <input
                type="text"
                value={overrideActor}
                onChange={(e) => setOverrideActor(e.target.value)}
                placeholder="admin_ui"
                style={{ maxWidth: 400, width: '100%' }}
                aria-label="Override actor"
              />
            </div>
          </FormSection>
          {error && <p style={{ color: '#c62828', marginBottom: 12 }}>{error}</p>}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            <Link to={`/events/${eventId}`} className="btn btn-secondary">Cancel</Link>
          </div>
        </form>
      </div>
    </>
  );
}
