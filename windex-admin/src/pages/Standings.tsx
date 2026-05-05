import React, { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { DataTable } from '../components/DataTable';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { getStandings, getPlayerStandingsHistory } from '../api/standings';
import { listGroups, listSeasons } from '../api/groups';
import type { StandingRow, Group, Season, PlayerStandingsHistoryResponse } from '../types';
import { seasonLabel } from '../types';

export function Standings() {
  const [searchParams] = useSearchParams();
  const [groups, setGroups] = useState<Group[]>([]);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [groupId, setGroupId] = useState(searchParams.get('group_id') ?? '');
  const [seasonId, setSeasonId] = useState(searchParams.get('season_id') ?? '');
  const [standings, setStandings] = useState<StandingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [standingsLoading, setStandingsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPlayer, setSelectedPlayer] = useState<StandingRow | null>(null);
  const [playerHistory, setPlayerHistory] = useState<PlayerStandingsHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    const g = searchParams.get('group_id') ?? '';
    const s = searchParams.get('season_id') ?? '';
    if (g) setGroupId(g);
    if (s) setSeasonId(s);
  }, [searchParams]);

  useEffect(() => {
    listGroups()
      .then(setGroups)
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!groupId) {
      setSeasons([]);
      setSeasonId('');
      return;
    }
    listSeasons(groupId)
      .then(setSeasons)
      .catch(() => setSeasons([]));
  }, [groupId]);

  useEffect(() => {
    if (!seasonId) {
      setStandings([]);
      setSelectedPlayer(null);
      setPlayerHistory(null);
      return;
    }
    setStandingsLoading(true);
    setSelectedPlayer(null);
    setPlayerHistory(null);
    getStandings(seasonId, groupId || undefined)
      .then(setStandings)
      .catch(() => setStandings([]))
      .finally(() => setStandingsLoading(false));
  }, [seasonId, groupId]);

  useEffect(() => {
    if (!selectedPlayer || !groupId || !seasonId) {
      setPlayerHistory(null);
      return;
    }
    setHistoryLoading(true);
    setPlayerHistory(null);
    getPlayerStandingsHistory(groupId, seasonId, selectedPlayer.player_id)
      .then(setPlayerHistory)
      .catch(() => setPlayerHistory(null))
      .finally(() => setHistoryLoading(false));
  }, [selectedPlayer?.player_id, groupId, seasonId]);

  const closeDrilldown = () => {
    setSelectedPlayer(null);
    setPlayerHistory(null);
  };

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;

  const columns = [
    { key: 'rank', label: 'Rank', render: (r: StandingRow) => r.rank ?? '—' },
    { key: 'player_name', label: 'Player', render: (r: StandingRow) => r.player_name ?? r.player_id?.slice(0, 8) ?? '—' },
    { key: 'rounds_played', label: 'Rounds played' },
    { key: 'total_points', label: 'Total points', render: (r: StandingRow) => Math.round(r.total_points) },
  ];

  return (
    <>
      <PageHeader title="Standings" subtitle="Points-only; derived from backend" />
      <div className="card">
        <h2>Select group and season</h2>
        <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>Select a group, then a season. Standings are points-only and derived from the ledger.</p>
        <div className="filter-bar">
          <label>
            Group
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">—</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </label>
          <label>
            Season
            <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)} disabled={!groupId}>
              <option value="">—</option>
              {seasons.map((s) => (
                <option key={s.id} value={s.id}>{seasonLabel(s)}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="card">
        <h2>Standings</h2>
        {!seasonId ? (
          <EmptyState message="Select a group and season to view standings." />
        ) : standingsLoading ? (
          <LoadingSpinner />
        ) : standings.length === 0 ? (
          <EmptyState message="No standings for this season yet." />
        ) : (
          <>
            <DataTable
              columns={columns}
              data={standings}
              getRowKey={(r) => r.player_id}
              onRowClick={setSelectedPlayer}
              selectedRowKey={selectedPlayer?.player_id ?? null}
            />
            <p style={{ fontSize: 12, color: '#666', marginTop: 8 }}>Click a row to see point history (rounds contributing to total).</p>
          </>
        )}
      </div>

      {selectedPlayer && (
        <div className="card" style={{ marginTop: 0 }}>
          <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Point history: {selectedPlayer.player_name ?? selectedPlayer.player_id.slice(0, 8)}</span>
            <button type="button" className="btn btn-secondary" onClick={closeDrilldown} style={{ fontSize: 13 }}>Close</button>
          </h2>
          {historyLoading ? (
            <LoadingSpinner />
          ) : playerHistory && playerHistory.history.length === 0 ? (
            <EmptyState message="No round-level points for this player in this season." detail="Rounds in this group/season that include this player will appear here." />
          ) : playerHistory ? (
            <>
              <p style={{ marginBottom: 12 }}>
                <strong>Total points</strong>: {Math.round(playerHistory.total_points)} &middot; <strong>Rounds</strong>: {playerHistory.rounds_played}
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Event</th>
                      <th>Points</th>
                      <th>Override</th>
                      <th>Reason / actor</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {playerHistory.history.map((row) => (
                      <tr key={row.event_id}>
                        <td>{row.round_date}</td>
                        <td><Link to={`/events/${row.event_id}`}>{row.event_id.slice(0, 8)}</Link></td>
                        <td>{Math.round(row.effective_points)}</td>
                        <td>{row.score_override != null ? <span style={{ color: '#e65100' }}>{row.score_override} (override)</span> : '—'}</td>
                        <td>
                          {row.score_override != null && (row.override_reason || row.override_actor || row.override_at) ? (
                            <span style={{ fontSize: 12 }}>
                              {row.override_reason ?? '—'}
                              {(row.override_actor || row.override_at) && (
                                <div style={{ color: '#888', marginTop: 2 }}>
                                  {[row.override_actor, row.override_at ? new Date(row.override_at).toLocaleString() : null].filter(Boolean).join(' · ')}
                                </div>
                              )}
                            </span>
                          ) : row.score_override != null ? '—' : '—'}
                        </td>
                        <td>{row.source_app ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>
      )}
    </>
  );
}
