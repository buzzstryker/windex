import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { ConfirmToast } from '../components/ConfirmToast';
import { isCurrentUserSuperAdmin, listGroups, listSeasons } from '../api/groups';
import {
  listCupChampionCandidates,
  getPlayerNames,
  setSeasonChampion,
  type CupChampionCandidate,
  type PlayerNames,
} from '../api/cupChampions';
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

export function CupChampions() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [championNames, setChampionNames] = useState<Map<string, PlayerNames>>(new Map());
  const [candidates, setCandidates] = useState<CupChampionCandidate[]>([]);
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingSeason, setEditingSeason] = useState<Season | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // Initial load: gate, groups, default group selection.
  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([isCurrentUserSuperAdmin(), listGroups()])
      .then(([admin, gs]) => {
        setIsSuperAdmin(admin);
        const sorted = [...gs].sort((a, b) => a.name.localeCompare(b.name));
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
    const championIds = sorted
      .map((s) => s.cup_champion_player_id)
      .filter((id): id is string => !!id);
    if (championIds.length > 0) {
      try {
        const names = await getPlayerNames(championIds);
        setChampionNames(names);
      } catch {
        setChampionNames(new Map());
      }
    } else {
      setChampionNames(new Map());
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

  return (
    <>
      <PageHeader
        title="Cup Champions"
        subtitle="Manually-recorded per-season champion (distinct from the auto-computed points-standings winner)."
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
        ) : seasons.length === 0 ? (
          <EmptyState message={`No seasons for ${selectedGroup.name} yet.`} />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
                <th style={th}>Season</th>
                <th style={th}>Status</th>
                <th style={th}>Champion</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {seasons.map((s) => {
                const status = seasonStatus(s, today);
                const championId = s.cup_champion_player_id ?? null;
                const championRecord = championId ? championNames.get(championId) : null;
                // Table renders full_name; fall back to display_name then id slice
                // if full_name is null (shouldn't happen — all current players
                // have full_name populated — but defensive).
                const championName = championId
                  ? championRecord?.full_name ?? championRecord?.display_name ?? championId.slice(0, 8)
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
                      {championName ? (
                        <span>{championName}</span>
                      ) : (
                        <span style={{ fontStyle: 'italic', color: '#999' }}>(not set)</span>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '4px 10px', fontSize: 13 }}
                        onClick={() => setEditingSeason(s)}
                      >
                        {championId ? 'Edit' : 'Set Champion'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editingSeason && (
        <SetChampionModal
          season={editingSeason}
          candidates={candidates}
          currentChampionDisplayName={
            editingSeason.cup_champion_player_id
              ? championNames.get(editingSeason.cup_champion_player_id)?.display_name ?? null
              : null
          }
          onClose={() => setEditingSeason(null)}
          onSaved={async (newPlayerId, newNotes) => {
            const savedSeason = editingSeason;
            setEditingSeason(null);
            const label = seasonLabel(savedSeason);
            if (newPlayerId === null) {
              setToast(`Champion cleared for ${label}`);
            } else {
              const name = candidates.find((c) => c.player_id === newPlayerId)?.display_name ?? 'champion';
              setToast(`${name} saved as champion for ${label}`);
            }
            // Reflect the change locally without an immediate refetch so the
            // toast and the table stay in sync visually, then refetch in the
            // background to pick up updated_at + any other server-side state.
            setSeasons((prev) =>
              prev.map((s) =>
                s.id === savedSeason.id
                  ? { ...s, cup_champion_player_id: newPlayerId, cup_champion_notes: newNotes }
                  : s
              )
            );
            try {
              await reloadSeasons(savedSeason.group_id);
            } catch {
              // Soft-fail — the optimistic local update is already in place.
            }
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

interface SetChampionModalProps {
  season: Season;
  candidates: CupChampionCandidate[];
  /** display_name of the current champion (picker uses nicknames, not full names). */
  currentChampionDisplayName: string | null;
  onClose: () => void;
  onSaved: (playerId: string | null, notes: string | null) => void | Promise<void>;
}

function SetChampionModal({
  season,
  candidates,
  currentChampionDisplayName,
  onClose,
  onSaved,
}: SetChampionModalProps) {
  const [playerId, setPlayerId] = useState<string>(season.cup_champion_player_id ?? '');
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

  // If the current champion is no longer in the candidates list (e.g.
  // ex-member), surface their name so the admin can see the existing value
  // even though selecting it again wouldn't be possible from the dropdown.
  const currentNotInCandidates =
    season.cup_champion_player_id &&
    !candidates.some((c) => c.player_id === season.cup_champion_player_id);

  const handleSave = async () => {
    setBusy(true);
    setErr(null);
    try {
      const newPlayerId = playerId === '' ? null : playerId;
      const newNotes = notes.trim() === '' ? null : notes.trim();
      await setSeasonChampion(season.id, newPlayerId, newNotes);
      await onSaved(newPlayerId, newNotes);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save');
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="champ-modal-title"
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
          <h2 id="champ-modal-title" style={{ margin: 0, fontSize: '1.1rem' }}>
            {season.cup_champion_player_id ? 'Edit Cup Champion' : 'Set Cup Champion'} — {seasonLabel(season)}
          </h2>
          <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>{formatRange(season)}</div>
        </div>

        <div style={{ padding: 20 }}>
          <div style={{ marginBottom: 14 }}>
            <label htmlFor="champ-player" style={labelStyle}>Champion</label>
            <select
              id="champ-player"
              value={playerId}
              onChange={(e) => setPlayerId(e.target.value)}
              style={inputStyle}
              disabled={busy}
            >
              <option value="">(none — clear champion)</option>
              {currentNotInCandidates && season.cup_champion_player_id && (
                <option value={season.cup_champion_player_id}>
                  {currentChampionDisplayName ?? season.cup_champion_player_id.slice(0, 8)} (no longer a member)
                </option>
              )}
              {candidates.map((c) => (
                <option key={c.player_id} value={c.player_id}>
                  {c.display_name}{c.is_active === 0 ? ' (inactive)' : ''}
                </option>
              ))}
            </select>
            <div style={hintStyle}>
              Dropdown shows current and former members of this group.
            </div>
          </div>

          <div style={{ marginBottom: 4 }}>
            <label htmlFor="champ-notes" style={labelStyle}>Notes (optional)</label>
            <textarea
              id="champ-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
              disabled={busy}
              placeholder="e.g. 18-hole match play playoff, final tournament shootout"
            />
          </div>

          {err && (
            <div role="alert" style={errorStyle}>
              {err}
            </div>
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
const td: React.CSSProperties = { padding: '10px 10px', verticalAlign: 'middle' };

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
