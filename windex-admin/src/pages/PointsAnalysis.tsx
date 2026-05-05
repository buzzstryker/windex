import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { listGroups } from '../api/groups';
import { listSeasons } from '../api/groups';
import { listPlayers } from '../api/players';
import {
  getMatrix, getHeadToHead, invalidateCache,
  type MatrixResult, type HeadToHeadResult, type SeasonSummary,
} from '../api/pointsAnalysis';
import type { Group, Season, Player } from '../types';
import { seasonLabel } from '../types';

export function PointsAnalysis() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [groups, setGroups] = useState<Group[]>([]);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [groupId, setGroupId] = useState(searchParams.get('group_id') ?? '');
  const [seasonId, setSeasonId] = useState<string>(searchParams.get('season_id') ?? '');
  const [matrix, setMatrix] = useState<MatrixResult | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const [excludeSig, setExcludeSig] = useState(true);
  const [matchupPlayer, setMatchupPlayer] = useState('');

  // Detail view state
  const [selectedA, setSelectedA] = useState<string | null>(searchParams.get('player_a'));
  const [selectedB, setSelectedB] = useState<string | null>(searchParams.get('player_b'));
  const [detail, setDetail] = useState<HeadToHeadResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [expandedSeason, setExpandedSeason] = useState<string | null>(null);

  useEffect(() => {
    listGroups().then(setGroups).catch(() => {});
  }, []);

  useEffect(() => {
    if (groupId) {
      listSeasons(groupId).then((all) => setSeasons(all.filter((s) => s.start_date >= '2022-12-01'))).catch(() => setSeasons([]));
      listPlayers(groupId).then(setPlayers).catch(() => setPlayers([]));
      invalidateCache();
    } else {
      setSeasons([]);
      setPlayers([]);
    }
    setMatrix(null);
    setDetail(null);
    setSelectedA(null);
    setSelectedB(null);
  }, [groupId]);

  const playerNameMap: Record<string, string> = {};
  for (const p of players) playerNameMap[p.id] = p.display_name;

  const name = (id: string) => playerNameMap[id] ?? id.slice(0, 8);

  // Active players = is_active on the player record (from /players?group_id=)
  const activePlayerIds = new Set(players.filter((p) => p.is_active === 1).map((p) => p.id));
  // Allowed season IDs (2023+) for "All" filter
  const allowedSeasonIds = new Set(seasons.map((s) => s.id));

  // Load matrix
  const loadMatrix = useCallback(async () => {
    if (!groupId) return;
    setMatrixLoading(true);
    setMatrixError(null);
    setDetail(null);
    setSelectedA(null);
    setSelectedB(null);
    try {
      const m = await getMatrix(groupId, seasonId || null, playerNameMap, activePlayerIds, seasonId ? undefined : allowedSeasonIds, excludeSig);
      setMatrix(m);
    } catch (e) {
      setMatrixError(e instanceof Error ? e.message : String(e));
    } finally {
      setMatrixLoading(false);
    }
  }, [groupId, seasonId, excludeSig, players.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (groupId && players.length > 0) loadMatrix();
  }, [groupId, seasonId, excludeSig, players.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load detail on cell click
  const handleCellClick = useCallback(async (a: string, b: string) => {
    if (selectedA === a && selectedB === b) {
      setSelectedA(null);
      setSelectedB(null);
      setDetail(null);
      return;
    }
    setSelectedA(a);
    setSelectedB(b);
    setDetail(null);
    setExpandedSeason(null);
    setDetailLoading(true);
    setSearchParams({ group_id: groupId, season_id: seasonId, player_a: a, player_b: b });
    try {
      const r = await getHeadToHead(groupId, a, b, allowedSeasonIds, excludeSig);
      setDetail(r);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, [groupId, seasonId, selectedA, selectedB, setSearchParams]);

  const nameA = selectedA ? name(selectedA) : '';
  const nameB = selectedB ? name(selectedB) : '';

  const sigBadge = (
    <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
      Signature Events: <strong style={{ color: excludeSig ? '#c62828' : '#2e7d32' }}>{excludeSig ? 'excluded' : 'included'}</strong>
    </div>
  );

  return (
    <>
      <PageHeader title="Points Analysis" subtitle="Game points differential — all players, all shared rounds." />

      <div className="card">
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-section" style={{ minWidth: 160, flex: 1 }}>
            <label htmlFor="pa-group">Group</label>
            <select id="pa-group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">Select group...</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div className="form-section" style={{ minWidth: 140, flex: 1 }}>
            <label htmlFor="pa-season">Season</label>
            <select id="pa-season" value={seasonId} onChange={(e) => setSeasonId(e.target.value)} disabled={!groupId}>
              <option value="">2023 to present</option>
              {seasons.map((s) => <option key={s.id} value={s.id}>{seasonLabel(s)}</option>)}
            </select>
          </div>
          <div className="form-section" style={{ minWidth: 160 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 22 }}>
              <input
                type="checkbox"
                checked={excludeSig}
                onChange={(e) => setExcludeSig(e.target.checked)}
                style={{ width: 16, height: 16 }}
              />
              Exclude Signature Events
            </label>
          </div>
        </div>
      </div>

      {matrixLoading && <LoadingSpinner />}
      {matrixError && <ErrorState message={matrixError} onRetry={loadMatrix} />}

      {matrix && matrix.playerIds.length === 0 && (
        <EmptyState message="No round data for this group/season." />
      )}

      {matrix && matrix.playerIds.length > 0 && (
        <div className="card">
          <h2>Game Points Differential</h2>
          <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
            Each cell shows row player's net game points vs column player across shared rounds. Click a cell for detail.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 13, whiteSpace: 'nowrap' }}>
              <thead>
                <tr>
                  <th style={{ padding: '6px 10px', borderBottom: '2px solid #ddd', position: 'sticky', left: 0, background: '#fff', zIndex: 1 }}></th>
                  {matrix.playerIds.map((col) => (
                    <th key={col} style={{ padding: '6px 10px', borderBottom: '2px solid #ddd', textAlign: 'center', fontWeight: 600 }}>
                      {name(col)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.playerIds.map((row) => (
                  <tr key={row}>
                    <td style={{
                      padding: '6px 10px', fontWeight: 600, borderBottom: '1px solid #eee',
                      position: 'sticky', left: 0, background: '#fff', zIndex: 1,
                    }}>
                      {name(row)}
                    </td>
                    {matrix.playerIds.map((col) => {
                      if (row === col) {
                        return <td key={col} style={{ padding: '6px 10px', borderBottom: '1px solid #eee', textAlign: 'center', color: '#ccc' }}>—</td>;
                      }
                      const cell = matrix.cells[row]?.[col];
                      if (!cell || cell.rounds === 0) {
                        return <td key={col} style={{ padding: '6px 10px', borderBottom: '1px solid #eee', textAlign: 'center', color: '#ccc' }}>—</td>;
                      }
                      const isSelected = selectedA === row && selectedB === col;
                      return (
                        <td
                          key={col}
                          onClick={() => handleCellClick(row, col)}
                          style={{
                            padding: '6px 10px',
                            borderBottom: '1px solid #eee',
                            textAlign: 'center',
                            cursor: 'pointer',
                            fontWeight: 600,
                            color: cell.net > 0 ? '#2e7d32' : cell.net < 0 ? '#c62828' : '#333',
                            background: isSelected ? '#e3f2fd' : undefined,
                          }}
                          title={`${name(row)} vs ${name(col)}: ${cell.net > 0 ? '+' : ''}${cell.net} over ${cell.rounds} rounds`}
                        >
                          {cell.net > 0 ? '+' : ''}{cell.net}
                          <span style={{ fontSize: 10, color: '#999', marginLeft: 3 }}>({cell.rounds})</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
            <span style={{ fontSize: 11, color: '#999' }}>* Data from 2023 season onward. Number in parentheses = shared rounds.</span>
            {sigBadge}
          </div>
        </div>
      )}

      {matrix && matrix.playerIds.length > 0 && (() => {
        // Build matchup list: filter by selected player or show top 10 worst across all
        const matchups: { a: string; b: string; net: number; rounds: number; avg: number }[] = [];
        if (matchupPlayer) {
          // Show selected player vs all others, sorted worst to best
          for (const b of matrix.playerIds) {
            if (b === matchupPlayer) continue;
            const cell = matrix.cells[matchupPlayer]?.[b];
            if (!cell || cell.rounds < 1) continue;
            matchups.push({ a: matchupPlayer, b, net: cell.net, rounds: cell.rounds, avg: cell.net / cell.rounds });
          }
          matchups.sort((x, y) => x.avg - y.avg);
        } else {
          // All players: top 10 worst per-round avg (min 3 rounds)
          for (const a of matrix.playerIds) {
            for (const b of matrix.playerIds) {
              if (a === b) continue;
              const cell = matrix.cells[a]?.[b];
              if (!cell || cell.rounds < 3) continue;
              matchups.push({ a, b, net: cell.net, rounds: cell.rounds, avg: cell.net / cell.rounds });
            }
          }
          matchups.sort((x, y) => x.avg - y.avg);
          matchups.splice(10);
        }

        const title = matchupPlayer
          ? `${name(matchupPlayer)} vs All (worst to best)`
          : '2023+ Worst Match Ups';
        const subtitle = matchupPlayer
          ? `${name(matchupPlayer)}'s per-round average against each opponent, ranked worst to best.`
          : 'Top 10 player vs player combinations with the biggest loss per round average (min 3 shared rounds).';

        return (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 8 }}>
              <h2 style={{ margin: 0 }}>{title}</h2>
              <div className="form-section" style={{ margin: 0, minWidth: 140 }}>
                <select value={matchupPlayer} onChange={(e) => setMatchupPlayer(e.target.value)} style={{ padding: '4px 8px', fontSize: 13 }}>
                  <option value="">All Players</option>
                  {matrix.playerIds.map((id) => <option key={id} value={id}>{name(id)}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: '#666' }}>{subtitle}</span>
              {sigBadge}
            </div>
            {matchups.length === 0 ? (
              <p style={{ color: '#999' }}>No matchups with enough shared rounds.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
                    <th style={{ padding: '8px 10px', width: 30 }}>#</th>
                    {!matchupPlayer && <th style={{ padding: '8px 10px' }}>Player</th>}
                    <th style={{ padding: '8px 10px' }}>vs</th>
                    <th style={{ padding: '8px 10px' }}>Avg / Round</th>
                    <th style={{ padding: '8px 10px' }}>Total</th>
                    <th style={{ padding: '8px 10px' }}>Rounds</th>
                  </tr>
                </thead>
                <tbody>
                  {matchups.map((m, i) => (
                    <tr
                      key={`${m.a}-${m.b}`}
                      style={{ borderBottom: '1px solid #eee', cursor: 'pointer' }}
                      onClick={() => handleCellClick(m.a, m.b)}
                    >
                      <td style={{ padding: '6px 10px', color: '#999' }}>{i + 1}</td>
                      {!matchupPlayer && <td style={{ padding: '6px 10px', fontWeight: 600 }}>{name(m.a)}</td>}
                      <td style={{ padding: '6px 10px' }}>{name(m.b)}</td>
                      <td style={{ padding: '6px 10px', color: m.avg > 0 ? '#2e7d32' : m.avg < 0 ? '#c62828' : undefined, fontWeight: 600 }}>{m.avg > 0 ? '+' : ''}{m.avg.toFixed(1)}</td>
                      <td style={{ padding: '6px 10px', color: m.net > 0 ? '#2e7d32' : m.net < 0 ? '#c62828' : undefined }}>{m.net > 0 ? '+' : ''}{m.net}</td>
                      <td style={{ padding: '6px 10px', color: '#666' }}>{m.rounds}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })()}

      {/* Detail view */}
      {detailLoading && <LoadingSpinner />}

      {detail && detail.totalRounds > 0 && selectedA && selectedB && (
        <>
          <div className="card">
            <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{nameA} vs {nameB}</span>
              <button type="button" className="btn btn-secondary" onClick={() => { setSelectedA(null); setSelectedB(null); setDetail(null); }} style={{ fontSize: 13 }}>Close</button>
            </h2>
            <div style={{ fontSize: 18, marginBottom: 12 }}>
              <strong>{nameA}</strong> is{' '}
              <span style={{ color: detail.totalNetA >= 0 ? '#2e7d32' : '#c62828', fontWeight: 700, fontSize: 22 }}>
                {detail.totalNetA >= 0 ? '+' : ''}{detail.totalNetA}
              </span>{' '}
              game points vs <strong>{nameB}</strong> across{' '}
              <strong>{detail.totalRounds}</strong> shared rounds, for an average of{' '}
              <strong>{detail.totalRounds ? (detail.totalNetA / detail.totalRounds).toFixed(1) : 0}</strong> per round.
            </div>
            <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
              <div>
                <span style={{ color: '#2e7d32', fontWeight: 600, fontSize: 20 }}>{detail.winsA}</span>{' '}
                <span style={{ color: '#666' }}>{nameA} wins</span>
              </div>
              <div>
                <span style={{ color: '#c62828', fontWeight: 600, fontSize: 20 }}>{detail.winsB}</span>{' '}
                <span style={{ color: '#666' }}>{nameB} wins</span>
              </div>
              <div>
                <span style={{ fontWeight: 600, fontSize: 20 }}>{detail.ties}</span>{' '}
                <span style={{ color: '#666' }}>ties</span>
              </div>
            </div>
            {sigBadge}
          </div>

          <div className="card">
            <h2>Season-by-Season</h2>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: '#666' }}>Click a season to see per-round detail.</span>
              {sigBadge}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
                  <th style={{ padding: '8px 12px' }}>Season</th>
                  <th style={{ padding: '8px 12px' }}>Rounds</th>
                  <th style={{ padding: '8px 12px' }}>{nameA}</th>
                  <th style={{ padding: '8px 12px' }}>{nameB}</th>
                  <th style={{ padding: '8px 12px' }}>Diff</th>
                  <th style={{ padding: '8px 12px' }}>Avg/Rd</th>
                  <th style={{ padding: '8px 12px' }}>{nameA} W</th>
                  <th style={{ padding: '8px 12px' }}>{nameB} W</th>
                  <th style={{ padding: '8px 12px' }}>Ties</th>
                </tr>
              </thead>
              <tbody>
                {detail.seasons.map((s) => {
                  const key = s.season_id ?? 'none';
                  const isExpanded = expandedSeason === key;
                  const seasonRounds = detail.rounds
                    .filter((r) => (r.season_id ?? 'none') === key)
                    .sort((a, b) => a.round_date.localeCompare(b.round_date));
                  return (
                    <SeasonRow
                      key={key}
                      season={s}
                      rounds={seasonRounds}
                      isExpanded={isExpanded}
                      onToggle={() => setExpandedSeason(isExpanded ? null : key)}
                      nameA={nameA}
                      nameB={nameB}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function SeasonRow({ season, rounds, isExpanded, onToggle, nameA, nameB }: {
  season: SeasonSummary;
  rounds: { round_date: string; pointsA: number; pointsB: number }[];
  isExpanded: boolean;
  onToggle: () => void;
  nameA: string;
  nameB: string;
}) {
  return (
    <>
      <tr onClick={onToggle} style={{ borderBottom: '1px solid #eee', cursor: 'pointer', background: isExpanded ? '#f5f5f5' : undefined }}>
        <td style={{ padding: '6px 12px' }}>{season.seasonYear}</td>
        <td style={{ padding: '6px 12px' }}>{season.rounds}</td>
        <td style={{ padding: '6px 12px' }}>{season.totalA}</td>
        <td style={{ padding: '6px 12px' }}>{season.totalB}</td>
        <td style={{ padding: '6px 12px', color: season.net > 0 ? '#2e7d32' : season.net < 0 ? '#c62828' : undefined, fontWeight: 600 }}>
          {season.net > 0 ? '+' : ''}{season.net}
        </td>
        <td style={{ padding: '6px 12px', color: season.net > 0 ? '#2e7d32' : season.net < 0 ? '#c62828' : undefined }}>
          {season.rounds ? (season.net / season.rounds).toFixed(1) : '—'}
        </td>
        <td style={{ padding: '6px 12px' }}>{season.winsA}</td>
        <td style={{ padding: '6px 12px' }}>{season.winsB}</td>
        <td style={{ padding: '6px 12px' }}>{season.ties}</td>
      </tr>
      {isExpanded && rounds.map((r, i) => {
        const net = Math.round(r.pointsA - r.pointsB);
        return (
          <tr key={i} style={{ borderBottom: '1px solid #f0f0f0', background: '#fafafa', fontSize: 13 }}>
            <td style={{ padding: '4px 12px 4px 24px', color: '#666' }}>{r.round_date}</td>
            <td style={{ padding: '4px 12px' }}></td>
            <td style={{ padding: '4px 12px' }}>{Math.round(r.pointsA)}</td>
            <td style={{ padding: '4px 12px' }}>{Math.round(r.pointsB)}</td>
            <td style={{ padding: '4px 12px', color: net > 0 ? '#2e7d32' : net < 0 ? '#c62828' : undefined, fontWeight: 600 }}>
              {net > 0 ? '+' : ''}{net}
            </td>
            <td style={{ padding: '4px 12px' }}></td>
            <td colSpan={3} style={{ padding: '4px 12px', color: '#666' }}>
              {net > 0 ? nameA : net < 0 ? nameB : 'Tie'}
            </td>
          </tr>
        );
      })}
    </>
  );
}
