import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { ConfirmToast } from '../components/ConfirmToast';
import { EditChampionshipResultsModal } from '../components/EditChampionshipResultsModal';
import { isCurrentUserSuperAdmin, listGroups, listSeasons } from '../api/groups';
import {
  listCupChampionCandidates,
  getPlayerNames,
  setSeasonChampion,
  type CupChampionCandidate,
  type PlayerNames,
} from '../api/cupChampions';
import {
  listChampionshipResultsForSeasons,
  type ChampionshipResult,
} from '../api/championshipResults';
import type { Group, Season } from '../types';
import { seasonLabel } from '../types';

type SeasonStatus = 'past' | 'current' | 'future';

function seasonStatus(s: Season, today: string): SeasonStatus {
  if (s.end_date < today) return 'past';
  if (s.start_date > today) return 'future';
  return 'current';
}

function formatRange(s: Season): string {
  const fmt = (iso: string): string => {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  };
  return `${fmt(s.start_date)}–${fmt(s.end_date)}`;
}

/** 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 4 -> "4th", 11 -> "11th"... */
function ordinal(n: number): string {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/**
 * Collapse a sorted list of place numbers into a compact ordinal label,
 * merging contiguous runs: [4,5,6,7,8] -> "4th–8th"; [3,5,6,7,8] -> "3rd, 5th–8th".
 */
function rangeLabel(nums: number[]): string {
  if (nums.length === 0) return '';
  const parts: string[] = [];
  let start = nums[0];
  let prev = nums[0];
  for (let i = 1; i <= nums.length; i++) {
    const n = nums[i];
    if (n === prev + 1) { prev = n; continue; }
    parts.push(start === prev ? ordinal(start) : `${ordinal(start)}–${ordinal(prev)}`);
    start = n;
    prev = n;
  }
  return parts.join(', ');
}

/**
 * Per-season completeness derived from the finishing-order rows. Field size =
 * the socks (last-place) finisher's place number — in standard competition
 * ranking the last place value equals the number of competitors. Missing
 * places are tie-aware: a recorded tie of k players at place p covers
 * p..p+k-1, so the skipped numbers in that span are NOT counted as absent.
 */
type Completeness =
  | { state: 'not-started' }
  | { state: 'unknown' }
  | { state: 'complete'; fieldSize: number }
  | { state: 'incomplete'; rowCount: number; fieldSize: number; missing: number; absentLabel: string };

function seasonCompleteness(rows: ChampionshipResult[]): Completeness {
  if (rows.length === 0) return { state: 'not-started' };

  const placed = rows.filter((r) => r.place !== null);
  const socks = rows.find((r) => r.is_last_place);
  const socksPlace = socks && socks.place !== null ? socks.place : null;
  // No socks place recorded -> field size unknown (can't compute the gap yet).
  if (socksPlace === null) return { state: 'unknown' };

  // Tie-aware covered set: k players tied at place p occupy p..p+k-1.
  const byPlace = new Map<number, number>();
  for (const r of placed) byPlace.set(r.place as number, (byPlace.get(r.place as number) ?? 0) + 1);
  const covered = new Set<number>();
  for (const [p, k] of byPlace) for (let i = 0; i < k; i++) covered.add(p + i);

  const absent: number[] = [];
  for (let p = 1; p <= socksPlace; p++) if (!covered.has(p)) absent.push(p);

  const rowCount = placed.length;
  const missing = socksPlace - rowCount;
  if (missing <= 0 && absent.length === 0) return { state: 'complete', fieldSize: socksPlace };
  return { state: 'incomplete', rowCount, fieldSize: socksPlace, missing, absentLabel: rangeLabel(absent) };
}

export function CupChampions() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [seasons, setSeasons] = useState<Season[]>([]);
  // Name resolution for every player id rendered in the top-3 column,
  // including the season's cup_champion_player_id fallback and any
  // ex-member ids from championship_results.
  const [playerNames, setPlayerNames] = useState<Map<string, PlayerNames>>(new Map());
  // championship_results grouped by season_id — the full finishing order.
  // Stored as a per-season ordered array (place asc, created_at asc; award-only
  // Socks rows last) so ties at a given place stay together on render.
  const [resultsBySeason, setResultsBySeason] = useState<Map<string, ChampionshipResult[]>>(new Map());
  const [candidates, setCandidates] = useState<CupChampionCandidate[]>([]);
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingResultsSeason, setEditingResultsSeason] = useState<Season | null>(null);
  const [editingNotesSeason, setEditingNotesSeason] = useState<Season | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // Show past + current + exactly the single coming season (the future row
  // with the smallest start_date). Hides the decades of far-future rows the
  // season-rollover cron over-projects (tracked separately in BACKLOG).
  const comingSeasonId = useMemo(() => {
    const futures = seasons.filter((s) => seasonStatus(s, today) === 'future');
    if (futures.length === 0) return null;
    return futures.reduce((earliest, s) => (s.start_date < earliest.start_date ? s : earliest)).id;
  }, [seasons, today]);
  const visibleSeasons = useMemo(
    () => seasons.filter((s) => seasonStatus(s, today) !== 'future' || s.id === comingSeasonId),
    [seasons, today, comingSeasonId],
  );

  // Completeness per visible season + the aggregate research-debt summary.
  const completenessBySeason = useMemo(() => {
    const m = new Map<string, Completeness>();
    for (const s of visibleSeasons) m.set(s.id, seasonCompleteness(resultsBySeason.get(s.id) ?? []));
    return m;
  }, [visibleSeasons, resultsBySeason]);
  const researchSummary = useMemo(() => {
    let toResearch = 0;
    let incompleteSeasons = 0;
    let unknownSeasons = 0;
    for (const c of completenessBySeason.values()) {
      if (c.state === 'incomplete') { toResearch += c.missing; incompleteSeasons += 1; }
      else if (c.state === 'unknown') unknownSeasons += 1;
    }
    return { toResearch, incompleteSeasons, unknownSeasons };
  }, [completenessBySeason]);

  // Initial load: gate, groups, default group selection.
  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([isCurrentUserSuperAdmin(), listGroups()])
      .then(([admin, gs]) => {
        setIsSuperAdmin(admin);
        // Rosters can't have a Cup champion — exclude them from this picker
        // (migration 052). Other admin surfaces still list rosters.
        const sorted = gs
          .filter((g) => g.group_type !== 'roster')
          .sort((a, b) => a.name.localeCompare(b.name));
        setGroups(sorted);
        if (sorted.length > 0) {
          // Prefer Windex Cup (has all the historical backfill data); fall
          // back to alphabetically first.
          const cup = sorted.find((g) => g.name === 'Windex Cup');
          setSelectedGroupId(cup?.id ?? sorted[0].id);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const reloadSeasons = useCallback(async (groupId: string) => {
    const list = await listSeasons(groupId);
    const sorted = [...list].sort((a, b) => b.start_date.localeCompare(a.start_date));
    setSeasons(sorted);

    // Pull the full championship_results set across all seasons in one shot.
    // Rows arrive ordered (season_id, place asc, created_at asc) with award-only
    // Socks rows (place=null) last within each season — see the render list.
    const seasonIds = sorted.map((s) => s.id);
    let results = new Map<string, ChampionshipResult[]>();
    let allResultIds: string[] = [];
    if (seasonIds.length > 0) {
      try {
        const allRows = await listChampionshipResultsForSeasons(seasonIds);
        for (const r of allRows) {
          const arr = results.get(r.season_id) ?? [];
          arr.push(r);
          results.set(r.season_id, arr);
        }
        allResultIds = allRows.map((r) => r.player_id);
      } catch {
        // Soft-fail: list view still renders the per-season champion fallback.
        results = new Map();
      }
    }
    setResultsBySeason(results);

    // Resolve names for: every top-3 player_id + every legacy
    // cup_champion_player_id (covers seasons with no results rows yet).
    const championIds = sorted
      .map((s) => s.cup_champion_player_id)
      .filter((id): id is string => !!id);
    const idSet = new Set<string>([...championIds, ...allResultIds]);
    if (idSet.size > 0) {
      try {
        const names = await getPlayerNames(Array.from(idSet));
        setPlayerNames(names);
      } catch {
        setPlayerNames(new Map());
      }
    } else {
      setPlayerNames(new Map());
    }
  }, []);

  // Whenever the selected group changes, reload its seasons + candidates.
  useEffect(() => {
    if (!selectedGroupId) return;
    let cancelled = false;
    setError(null);
    Promise.all([
      reloadSeasons(selectedGroupId),
      listCupChampionCandidates(selectedGroupId),
    ])
      .then(([_, cands]) => {
        if (cancelled) return;
        setCandidates(cands);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [selectedGroupId, reloadSeasons]);

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;
  if (isSuperAdmin === false) {
    return (
      <>
        <PageHeader title="Cup Champions" />
        <div className="card">
          <p style={{ color: '#666' }}>This page is restricted to super admins.</p>
        </div>
      </>
    );
  }

  const selectedGroup = groups.find((g) => g.id === selectedGroupId) ?? null;

  const resolveName = (playerId: string | null | undefined): string | null => {
    if (!playerId) return null;
    const rec = playerNames.get(playerId);
    return rec?.full_name ?? rec?.display_name ?? playerId.slice(0, 8);
  };

  return (
    <>
      <PageHeader
        title="Cup Champions"
        subtitle="Full per-season finishing order (canonical). Notes stay on the season row."
      />

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <label htmlFor="cup-group-select" style={{ fontWeight: 600 }}>Group:</label>
          <select
            id="cup-group-select"
            value={selectedGroupId}
            onChange={(e) => setSelectedGroupId(e.target.value)}
            style={{ padding: '6px 8px', borderRadius: 4, border: '1px solid #ccc', fontSize: 14 }}
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </div>

        {!selectedGroup ? (
          <EmptyState message="No groups available." />
        ) : visibleSeasons.length === 0 ? (
          <EmptyState message={`No seasons for ${selectedGroup.name} yet.`} />
        ) : (
          <>
            {(researchSummary.toResearch > 0 || researchSummary.unknownSeasons > 0) && (
              <div style={summaryBarStyle}>
                {researchSummary.toResearch > 0 && (
                  <strong>
                    {researchSummary.toResearch} finisher{researchSummary.toResearch === 1 ? '' : 's'} still to
                    research across {researchSummary.incompleteSeasons} season
                    {researchSummary.incompleteSeasons === 1 ? '' : 's'}
                  </strong>
                )}
                {researchSummary.toResearch > 0 && researchSummary.unknownSeasons > 0 && ' · '}
                {researchSummary.unknownSeasons > 0 && (
                  <span>
                    {researchSummary.unknownSeasons} season{researchSummary.unknownSeasons === 1 ? '' : 's'} need
                    {researchSummary.unknownSeasons === 1 ? 's' : ''} a last-place recorded
                  </span>
                )}
              </div>
            )}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
                <th style={th}>Season</th>
                <th style={th}>Status</th>
                <th style={th}>Finishing Order</th>
                <th style={th}>Completeness</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {visibleSeasons.map((s) => {
                const status = seasonStatus(s, today);
                const results = resultsBySeason.get(s.id) ?? [];
                const championFallback = results.length === 0
                  ? resolveName(s.cup_champion_player_id ?? null)
                  : null;
                const rowStyle: React.CSSProperties = {
                  borderBottom: '1px solid #eee',
                  background: status === 'current' ? '#fffbe6' : undefined,
                  color: status === 'future' ? '#888' : undefined,
                };
                return (
                  <tr key={s.id} style={rowStyle}>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{seasonLabel(s)}</div>
                      <div style={{ fontSize: 12, color: status === 'future' ? '#888' : '#666' }}>
                        {formatRange(s)}
                      </div>
                    </td>
                    <td style={td}>
                      <StatusBadge status={status} />
                    </td>
                    <td style={td}>
                      {results.length > 0 ? (
                        <FinishingOrderList rows={results} resolveName={resolveName} />
                      ) : championFallback ? (
                        <span style={{ fontSize: 13 }}>
                          <strong>1.</strong> {championFallback}
                        </span>
                      ) : (
                        <span style={{ fontStyle: 'italic', color: '#999' }}>No results recorded yet</span>
                      )}
                    </td>
                    <td style={td}>
                      <CompletenessCell c={completenessBySeason.get(s.id) ?? { state: 'not-started' }} />
                    </td>
                    <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '4px 10px', fontSize: 13, marginRight: 6 }}
                        onClick={() => setEditingResultsSeason(s)}
                      >
                        Edit Results
                      </button>
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '4px 10px', fontSize: 13 }}
                        onClick={() => setEditingNotesSeason(s)}
                      >
                        Notes
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            </table>
          </>
        )}
      </div>

      {editingResultsSeason && (
        <EditChampionshipResultsModal
          season={editingResultsSeason}
          candidates={candidates}
          isCurrentSeason={seasonStatus(editingResultsSeason, today) === 'current'}
          onClose={() => setEditingResultsSeason(null)}
          onSaved={async () => {
            const saved = editingResultsSeason;
            setEditingResultsSeason(null);
            setToast(`Results saved for ${seasonLabel(saved)}`);
            try {
              await reloadSeasons(saved.group_id);
            } catch {
              // Optimistic state already cleared; soft-fail is acceptable.
            }
          }}
        />
      )}

      {editingNotesSeason && (
        <EditNotesModal
          season={editingNotesSeason}
          onClose={() => setEditingNotesSeason(null)}
          onSaved={async (newNotes) => {
            const saved = editingNotesSeason;
            setEditingNotesSeason(null);
            setToast(`Notes saved for ${seasonLabel(saved)}`);
            setSeasons((prev) =>
              prev.map((row) =>
                row.id === saved.id ? { ...row, cup_champion_notes: newNotes } : row
              )
            );
          }}
        />
      )}

      {toast && <ConfirmToast message={toast} onClose={() => setToast(null)} duration={4000} />}
    </>
  );
}

function StatusBadge({ status }: { status: SeasonStatus }) {
  const styles: Record<SeasonStatus, React.CSSProperties> = {
    past: { background: '#eee', color: '#555' },
    current: { background: '#fff3cd', color: '#856404', border: '1px solid #ffeeba' },
    future: { background: '#f5f5f5', color: '#999', fontStyle: 'italic' },
  };
  const labels: Record<SeasonStatus, string> = {
    past: 'Past',
    current: 'Current',
    future: 'Future',
  };
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 10,
      fontSize: 12,
      fontWeight: 600,
      ...styles[status],
    }}>
      {labels[status]}
    </span>
  );
}

/**
 * Renders the full finishing order for a season. Rows arrive ordered by
 * (place asc, created_at asc) with award-only Socks rows (place=null) last.
 * Ties at a given place are listed on the same line; any is_last_place row
 * gets a 🧦, and award-only Socks winners (no place) render as a separate
 * line below the placed rows.
 */
function FinishingOrderList({
  rows,
  resolveName,
}: {
  rows: ChampionshipResult[];
  resolveName: (id: string | null | undefined) => string | null;
}) {
  // Placed rows grouped by place (ties share a line); award-only Socks rows
  // (place=null && is_last_place) collected for a trailing line.
  const byPlace = new Map<number, string[]>();
  const socksOnly: string[] = [];
  for (const r of rows) {
    const name = resolveName(r.player_id) ?? r.player_id.slice(0, 8);
    if (r.place === null) {
      if (r.is_last_place) socksOnly.push(name);
      continue;
    }
    const label = r.is_last_place ? `${name} 🧦` : name;
    const arr = byPlace.get(r.place) ?? [];
    arr.push(label);
    byPlace.set(r.place, arr);
  }
  const places = Array.from(byPlace.keys()).sort((a, b) => a - b);
  return (
    <div style={{ fontSize: 13, lineHeight: '18px' }}>
      {places.map((p) => (
        <div key={p}>
          <strong>{p}.</strong> {byPlace.get(p)!.join(', ')}
        </div>
      ))}
      {socksOnly.map((name, i) => (
        <div key={`socks-${i}`}>🧦 {name}</div>
      ))}
    </div>
  );
}

/**
 * Per-season completeness indicator. Three research-relevant states (complete /
 * incomplete-known-field / field-unknown) plus a neutral "not started" for
 * seasons with no results yet (current/coming — future work, not research debt).
 */
function CompletenessCell({ c }: { c: Completeness }) {
  const pill: React.CSSProperties = {
    display: 'inline-block', padding: '2px 8px', borderRadius: 10,
    fontSize: 12, fontWeight: 600,
  };
  switch (c.state) {
    case 'not-started':
      return <span style={{ color: '#bbb' }}>—</span>;
    case 'unknown':
      return (
        <span style={{ fontSize: 12, color: '#777' }} title="Record the last-place (socks) finisher to establish the field size">
          Field size unknown · record last place first
        </span>
      );
    case 'complete':
      return <span style={{ ...pill, background: '#e6f4ea', color: '#1e7e34' }}>✓ Complete · field of {c.fieldSize}</span>;
    case 'incomplete':
      return (
        <span style={{ ...pill, background: '#fff3cd', color: '#856404', whiteSpace: 'normal' }}>
          {c.rowCount} of {c.fieldSize} recorded{c.absentLabel ? ` · research ${c.absentLabel}` : ''}
        </span>
      );
  }
}

/**
 * Notes-only editor. Per the locked spec, seasons.cup_champion_notes stays
 * editable directly on the season row, orthogonal to championship_results.
 * The original SetChampionModal's player picker was removed because
 * championship_results is now canonical for the winner — the sync trigger
 * would silently overwrite any picker-set value.
 */
function EditNotesModal({
  season,
  onClose,
  onSaved,
}: {
  season: Season;
  onClose: () => void;
  onSaved: (notes: string | null) => void | Promise<void>;
}) {
  const [notes, setNotes] = useState<string>(season.cup_champion_notes ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const handleSave = async () => {
    setBusy(true);
    setErr(null);
    try {
      const newNotes = notes.trim() === '' ? null : notes.trim();
      // setSeasonChampion handles the seasons PATCH; pass current
      // cup_champion_player_id verbatim so we don't unintentionally clear
      // it (the sync trigger keeps it in lockstep otherwise).
      await setSeasonChampion(season.id, season.cup_champion_player_id ?? null, newNotes);
      await onSaved(newNotes);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save');
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="notes-modal-title"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div style={{ background: '#fff', borderRadius: 8, maxWidth: 480, width: '100%', boxShadow: '0 10px 30px rgba(0,0,0,0.25)', overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', background: '#f5f5f5', borderBottom: '1px solid #e0e0e0' }}>
          <h2 id="notes-modal-title" style={{ margin: 0, fontSize: '1.1rem' }}>
            Cup Champion Notes — {seasonLabel(season)}
          </h2>
          <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>{formatRange(season)}</div>
        </div>

        <div style={{ padding: 20 }}>
          <label htmlFor="champ-notes" style={labelStyle}>
            Notes (optional)
          </label>
          <textarea
            id="champ-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
            disabled={busy}
            placeholder="e.g. 18-hole match play playoff, final tournament shootout"
          />
          <div style={hintStyle}>
            Winner is set in "Edit Results"; this field is just the prose explanation.
          </div>

          {err && (
            <div role="alert" style={errorStyle}>{err}</div>
          )}
        </div>

        <div style={{ padding: '12px 20px', background: '#fafafa', borderTop: '1px solid #e0e0e0', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            onClick={handleSave}
            disabled={busy}
            className="btn"
            style={{ background: '#0d47a1', color: '#fff', opacity: busy ? 0.7 : 1 }}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: '8px 10px' };
const td: React.CSSProperties = { padding: '10px 10px', verticalAlign: 'top' };

const summaryBarStyle: React.CSSProperties = {
  marginBottom: 12,
  padding: '8px 12px',
  background: '#f8f9fa',
  border: '1px solid #e0e0e0',
  borderRadius: 4,
  fontSize: 13,
  color: '#444',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 6,
  color: '#1a1a1a',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  borderRadius: 4,
  border: '1px solid #ccc',
  fontSize: 14,
};

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#666',
  marginTop: 4,
};

const errorStyle: React.CSSProperties = {
  marginTop: 16,
  padding: '10px 12px',
  background: '#ffebee',
  color: '#c62828',
  border: '1px solid #f5c6c2',
  borderRadius: 4,
  fontSize: 13,
};
