import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { FormSection } from '../components/FormSection';
import { ConfirmToast } from '../components/ConfirmToast';
import { listGroups, listSeasons } from '../api/groups';
import { listPlayers } from '../api/players';
import { ingestEvent } from '../api/events';
import type { Group, Season, Player } from '../types';
import { seasonLabel } from '../types';

interface ScoreRow {
  player_id: string;
  score_value: number;
}

export function RoundEntry() {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<Group[]>([]);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [groupId, setGroupId] = useState('');
  const [seasonId, setSeasonId] = useState('');
  const [roundDate, setRoundDate] = useState('');
  const [scores, setScores] = useState<ScoreRow[]>([{ player_id: '', score_value: 0 }]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    listGroups()
      .then(setGroups)
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!groupId) {
      setSeasons([]);
      setPlayers([]);
      setSeasonId('');
      return;
    }
    listSeasons(groupId).then(setSeasons).catch(() => setSeasons([]));
    listPlayers(groupId).then(setPlayers).catch(() => setPlayers([]));
  }, [groupId]);

  const addRow = () => setScores((s) => [...s, { player_id: '', score_value: 0 }]);
  const removeRow = (i: number) => setScores((s) => s.filter((_, j) => j !== i));
  const updateRow = (i: number, field: 'player_id' | 'score_value', value: string | number) => {
    setScores((s) => s.map((row, j) => (j === i ? { ...row, [field]: value } : row)));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupId || !roundDate) {
      setError('Group and played date are required.');
      return;
    }
    const validScores = scores.filter((r) => r.player_id.trim() !== '').map((r) => ({ player_id: r.player_id.trim(), score_value: r.score_value }));
    if (validScores.length === 0) {
      setError('At least one player with points is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await ingestEvent({
        group_id: groupId,
        season_id: seasonId || null,
        round_date: roundDate,
        source_app: 'manual',
        scores: validScores,
      });
      setToast('Round created.');
      navigate(`/events/${result.league_round_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create round');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading"><div className="spinner" /></div>;

  return (
    <>
      <PageHeader title="Round entry" subtitle="Manual round creation (first-class workflow)" />
      {toast && <ConfirmToast message={toast} onClose={() => setToast(null)} />}
      <div className="card">
        <form onSubmit={handleSubmit}>
          <FormSection title="Event">
            <label>Group (required)</label>
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)} required>
              <option value="">—</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <label style={{ marginTop: 12 }}>Season (optional)</label>
            <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)}>
              <option value="">—</option>
              {seasons.map((s) => (
                <option key={s.id} value={s.id}>{seasonLabel(s)}</option>
              ))}
            </select>
            <label style={{ marginTop: 12 }}>Played date (required)</label>
            <input type="date" value={roundDate} onChange={(e) => setRoundDate(e.target.value)} required />
          </FormSection>
          <FormSection title="Players &amp; points">
            <p style={{ fontSize: 12, color: '#666' }}>Source app is set to &quot;manual&quot;. Enter awarded point totals per player (not golf scorecard data). {players.length > 0 ? 'Select players from the group or enter a player ID.' : 'Enter player IDs and points.'}</p>
            {scores.map((row, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                {players.length > 0 ? (
                  <select
                    value={row.player_id}
                    onChange={(e) => updateRow(i, 'player_id', e.target.value)}
                    style={{ flex: 1, maxWidth: 320 }}
                  >
                    <option value="">— Select player —</option>
                    {players.map((p) => (
                      <option key={p.id} value={p.id}>{p.display_name}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    placeholder="Player ID"
                    value={row.player_id}
                    onChange={(e) => updateRow(i, 'player_id', e.target.value)}
                    style={{ flex: 1, maxWidth: 320 }}
                  />
                )}
                <input
                  type="number"
                  placeholder="Points"
                  value={row.score_value}
                  onChange={(e) => updateRow(i, 'score_value', Number(e.target.value))}
                  style={{ width: 80 }}
                />
                <button type="button" className="btn btn-secondary" onClick={() => removeRow(i)} disabled={scores.length <= 1}>Remove</button>
              </div>
            ))}
            <button type="button" className="btn btn-secondary" onClick={addRow}>Add player</button>
          </FormSection>
          {error && <p style={{ color: '#c62828', marginBottom: 12 }}>{error}</p>}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Creating…' : 'Create round'}</button>
            <Link to="/events" className="btn btn-secondary">Cancel</Link>
          </div>
        </form>
      </div>
    </>
  );
}
