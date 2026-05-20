import { useEffect, useMemo, useState } from 'react';
import type { Season } from '../types';
import { seasonLabel } from '../types';
import {
  type ChampionshipResult,
  type FinishingOrderEntry,
  listChampionshipResults,
  replaceFinishingOrder,
  validateStandardCompetitionRanking,
} from '../api/championshipResults';
import type { CupChampionCandidate, PlayerNames } from '../api/cupChampions';
import { getPlayerNames } from '../api/cupChampions';

interface Props {
  season: Season;
  /**
   * Current-season candidates (members of the group). For historical seasons
   * we still surface this list as the default suggestion but allow free-form
   * player selection from `allPlayers` via search.
   */
  candidates: CupChampionCandidate[];
  /** True if `season` is the current season (membership trigger will enforce). */
  isCurrentSeason: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

interface DraftRow {
  /** Stable client-only id so React keys stay put across reorders/deletes. */
  key: string;
  player_id: string;
  place: number | '';
}

let _rowKeySeq = 0;
const nextKey = () => `r${++_rowKeySeq}`;

export function EditChampionshipResultsModal({
  season,
  candidates,
  isCurrentSeason,
  onClose,
  onSaved,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<DraftRow[]>([]);
  // Names for any player IDs in the existing results that aren't in
  // `candidates` (i.e. ex-members on historical seasons). Looked up on load.
  const [exMemberNames, setExMemberNames] = useState<Map<string, PlayerNames>>(new Map());
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmingWarning, setConfirmingWarning] = useState<string | null>(null);

  // Esc to close (only when not busy).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  // Initial load: pull existing rows + look up any ex-member names.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    listChampionshipResults(season.id)
      .then(async (existing: ChampionshipResult[]) => {
        if (cancelled) return;
        const initialRows: DraftRow[] = existing.map((r) => ({
          key: nextKey(),
          player_id: r.player_id,
          place: r.place,
        }));
        setRows(initialRows);

        // Look up names for any existing-result player_ids that aren't in
        // candidates (ex-members). Skip lookup if everything is covered.
        const candidateIds = new Set(candidates.map((c) => c.player_id));
        const missing = existing
          .map((r) => r.player_id)
          .filter((id) => !candidateIds.has(id));
        if (missing.length > 0) {
          try {
            const names = await getPlayerNames(missing);
            if (!cancelled) setExMemberNames(names);
          } catch {
            // Soft-fail: the dropdown will still show the id as a fallback.
          }
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [season.id, candidates]);

  const usedPlayerIds = useMemo(
    () => new Set(rows.map((r) => r.player_id).filter((p) => p !== '')),
    [rows]
  );

  const handleAddRow = () => {
    // Default place: max existing + 1, falling back to 1.
    const maxPlace = rows.reduce(
      (m, r) => (typeof r.place === 'number' && r.place > m ? r.place : m),
      0
    );
    setRows((prev) => [...prev, { key: nextKey(), player_id: '', place: maxPlace + 1 }]);
  };

  const handleRemoveRow = (key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
  };

  const handleChangePlayer = (key: string, playerId: string) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, player_id: playerId } : r)));
  };

  const handleChangePlace = (key: string, raw: string) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        if (raw === '') return { ...r, place: '' };
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 1) return r;
        return { ...r, place: Math.floor(n) };
      })
    );
  };

  const validateBeforeSave = (): { entries: FinishingOrderEntry[]; warning: string | null } | null => {
    setSaveError(null);
    // Every row must have a player and a place.
    for (const r of rows) {
      if (!r.player_id) {
        setSaveError('Every row needs a player selected.');
        return null;
      }
      if (r.place === '' || typeof r.place !== 'number' || r.place < 1) {
        setSaveError('Every row needs a valid place (1 or higher).');
        return null;
      }
    }
    // Player must be unique. (UNIQUE constraint also enforces this, but
    // surfacing client-side gives a clearer message.)
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.player_id)) {
        setSaveError('Each player can only appear once.');
        return null;
      }
      seen.add(r.player_id);
    }
    const entries: FinishingOrderEntry[] = rows.map((r) => ({
      player_id: r.player_id,
      place: r.place as number,
    }));
    const warning = validateStandardCompetitionRanking(entries.map((e) => e.place));
    return { entries, warning };
  };

  const doSave = async (entries: FinishingOrderEntry[]) => {
    setBusy(true);
    setSaveError(null);
    try {
      await replaceFinishingOrder(season.id, season.group_id, entries);
      await onSaved();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save');
      setBusy(false);
    }
  };

  const handleSaveClick = () => {
    const v = validateBeforeSave();
    if (!v) return;
    if (v.warning) {
      setConfirmingWarning(v.warning);
      return;
    }
    void doSave(v.entries);
  };

  const handleConfirmWarning = () => {
    const v = validateBeforeSave();
    setConfirmingWarning(null);
    if (!v) return;
    void doSave(v.entries);
  };

  const resolveName = (playerId: string): string => {
    const cand = candidates.find((c) => c.player_id === playerId);
    if (cand) return cand.display_name;
    const ex = exMemberNames.get(playerId);
    if (ex) return ex.display_name;
    return playerId.slice(0, 8);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="results-modal-title"
      style={overlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div style={modalStyle}>
        <div style={headerStyle}>
          <h2 id="results-modal-title" style={{ margin: 0, fontSize: '1.1rem' }}>
            Edit Championship Results — {seasonLabel(season)}
          </h2>
          <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>
            {isCurrentSeason
              ? 'Current season — only group members can be added.'
              : 'Historical season — any player can be added.'}
          </div>
        </div>

        <div style={{ padding: 20, maxHeight: '60vh', overflowY: 'auto' }}>
          {loading ? (
            <div style={{ color: '#666', fontSize: 14 }}>Loading existing results…</div>
          ) : loadError ? (
            <div style={errorStyle}>{loadError}</div>
          ) : (
            <>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #ddd', textAlign: 'left' }}>
                    <th style={{ padding: '6px 4px', width: 80 }}>Place</th>
                    <th style={{ padding: '6px 4px' }}>Player</th>
                    <th style={{ padding: '6px 4px', width: 40 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={3} style={{ padding: '14px 4px', color: '#888', fontStyle: 'italic' }}>
                        No finishers yet. Click "Add finisher" to start.
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.key} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={{ padding: '4px 4px' }}>
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={r.place}
                          onChange={(e) => handleChangePlace(r.key, e.target.value)}
                          style={{ ...inputStyle, width: 70 }}
                          disabled={busy}
                        />
                      </td>
                      <td style={{ padding: '4px 4px' }}>
                        <select
                          value={r.player_id}
                          onChange={(e) => handleChangePlayer(r.key, e.target.value)}
                          style={inputStyle}
                          disabled={busy}
                        >
                          <option value="">(select player)</option>
                          {/* Render the current value first if it's an ex-member
                              not in candidates, so the dropdown always shows the
                              selected name. */}
                          {r.player_id && !candidates.some((c) => c.player_id === r.player_id) && (
                            <option value={r.player_id}>
                              {resolveName(r.player_id)} (no longer a member)
                            </option>
                          )}
                          {candidates.map((c) => {
                            const disabled = usedPlayerIds.has(c.player_id) && c.player_id !== r.player_id;
                            return (
                              <option
                                key={c.player_id}
                                value={c.player_id}
                                disabled={disabled}
                              >
                                {c.display_name}
                                {c.is_active === 0 ? ' (inactive)' : ''}
                                {disabled ? ' — already added' : ''}
                              </option>
                            );
                          })}
                        </select>
                      </td>
                      <td style={{ padding: '4px 4px', textAlign: 'right' }}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '4px 8px', fontSize: 12 }}
                          onClick={() => handleRemoveRow(r.key)}
                          disabled={busy}
                          aria-label="Remove finisher"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleAddRow}
                  disabled={busy}
                  style={{ padding: '6px 12px', fontSize: 13 }}
                >
                  + Add finisher
                </button>
              </div>

              <div style={hintStyle}>
                Standard competition ranking: ties share a place; the next place skips ahead
                (e.g. 1, 2, 2, 4, 5). The save will warn — but not block — if ranking looks off.
              </div>

              {saveError && (
                <div role="alert" style={errorStyle}>{saveError}</div>
              )}
            </>
          )}
        </div>

        <div style={footerStyle}>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            onClick={handleSaveClick}
            disabled={busy || loading || !!loadError}
            className="btn"
            style={{ background: '#0d47a1', color: '#fff', opacity: busy ? 0.7 : 1 }}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {confirmingWarning && (
        <div
          role="alertdialog"
          aria-modal="true"
          style={{ ...overlayStyle, zIndex: 2100 }}
          onClick={(e) => { if (e.target === e.currentTarget) setConfirmingWarning(null); }}
        >
          <div style={{ ...modalStyle, maxWidth: 420 }}>
            <div style={headerStyle}>
              <h3 style={{ margin: 0, fontSize: '1rem' }}>Ranking warning</h3>
            </div>
            <div style={{ padding: 20, fontSize: 14, color: '#333' }}>
              <p style={{ marginTop: 0 }}>{confirmingWarning}</p>
              <p style={{ marginBottom: 0 }}>Save anyway?</p>
            </div>
            <div style={footerStyle}>
              <button className="btn btn-secondary" onClick={() => setConfirmingWarning(null)}>
                Go back
              </button>
              <button
                onClick={handleConfirmWarning}
                className="btn"
                style={{ background: '#0d47a1', color: '#fff' }}
              >
                Save anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 2000,
  padding: 16,
};

const modalStyle: React.CSSProperties = {
  background: '#fff',
  borderRadius: 8,
  maxWidth: 560,
  width: '100%',
  boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
  overflow: 'hidden',
};

const headerStyle: React.CSSProperties = {
  padding: '14px 20px',
  background: '#f5f5f5',
  borderBottom: '1px solid #e0e0e0',
};

const footerStyle: React.CSSProperties = {
  padding: '12px 20px',
  background: '#fafafa',
  borderTop: '1px solid #e0e0e0',
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
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
  marginTop: 10,
};

const errorStyle: React.CSSProperties = {
  marginTop: 12,
  padding: '10px 12px',
  background: '#ffebee',
  color: '#c62828',
  border: '1px solid #f5c6c2',
  borderRadius: 4,
  fontSize: 13,
};
