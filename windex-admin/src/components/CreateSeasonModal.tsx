import { useEffect, useMemo, useState } from 'react';
import {
  createSeason,
  getGroupSeasonStartMonth,
  type CreateSeasonResult,
} from '../api/groups';
import type { Group, Season } from '../types';

interface CreateSeasonModalProps {
  open: boolean;
  group: Group;
  /** Existing seasons for this group, used to default the new year. */
  existingSeasons: Season[];
  onClose: () => void;
  onSuccess: (season: CreateSeasonResult) => void;
}

/**
 * Super-admin-only modal for bootstrapping a new season on a group with
 * zero seasons (or for backfilling an unusual schedule). For groups that
 * already have seasons, the daily auto-rollover (migration 021) handles
 * future seasons automatically — this UI exists primarily for the seed-
 * season case where the rollover has nothing to extrapolate from.
 *
 * Defaults:
 *   - year = (existing.maxYear + 1) if any seasons exist, else current year
 *   - start_date = year-{ssm}-01 (using the group's season_start_month)
 *   - end_date   = start_date + 1 year - 1 day
 *
 * Either default can be edited before submit. ID generation matches the
 * `sn_<group_id>_<endYear>` pattern used by ensure_next_season_for_group.
 */
export function CreateSeasonModal({
  open,
  group,
  existingSeasons,
  onClose,
  onSuccess,
}: CreateSeasonModalProps) {
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [ssm, setSsm] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [defaultsApplied, setDefaultsApplied] = useState(false);

  // Resolve the default year. Prefer the year following the most recent
  // season's end_date; fall back to current year if there are no seasons.
  const defaultYear = useMemo(() => {
    if (existingSeasons.length === 0) return new Date().getFullYear();
    const maxEnd = [...existingSeasons]
      .map((s) => s.end_date)
      .sort()
      .reverse()[0];
    if (!maxEnd) return new Date().getFullYear();
    return parseInt(maxEnd.slice(0, 4), 10) + 1;
  }, [existingSeasons]);

  // Compute defaulted start/end given a year and ssm. Pulled out so re-applying
  // when ssm loads is clean.
  const computeDefaults = (y: number, monthHint: number | null) => {
    const month = monthHint ?? 1; // fall back to January if no schedule
    const start = `${y}-${String(month).padStart(2, '0')}-01`;
    // end = start + 1 year - 1 day, computed in UTC to avoid TZ drift
    const startUtc = new Date(`${start}T00:00:00Z`);
    const endUtc = new Date(startUtc.getTime());
    endUtc.setUTCFullYear(endUtc.getUTCFullYear() + 1);
    endUtc.setUTCDate(endUtc.getUTCDate() - 1);
    const end = endUtc.toISOString().slice(0, 10);
    return { start, end };
  };

  // Seed-season default year. When a group has NO seasons yet, the first
  // season must CONTAIN today rather than project into the future (the bug
  // that left "Adam TBD" with only future-dated seasons). Given the group's
  // season_start_month, today falls in this calendar year's window iff
  // today's month >= ssm; otherwise the current window started last year.
  // Groups that already have seasons are unchanged — they keep extending the
  // existing chain via defaultYear (maxEnd year + 1).
  const resolveSeedYear = (monthHint: number | null): number => {
    if (existingSeasons.length > 0) return defaultYear;
    const today = new Date();
    const todayMonth = today.getMonth() + 1; // 1-12
    const todayYear = today.getFullYear();
    const ssm = monthHint ?? 1; // mirror computeDefaults' January fallback
    return todayMonth >= ssm ? todayYear : todayYear - 1;
  };

  // Reset on close so reopening is clean.
  useEffect(() => {
    if (!open) {
      setYear(new Date().getFullYear());
      setStartDate('');
      setEndDate('');
      setSsm(null);
      setBusy(false);
      setError(null);
      setLoading(false);
      setDefaultsApplied(false);
    }
  }, [open]);

  // On open, fetch the group's season_start_month and set defaults.
  useEffect(() => {
    if (!open || defaultsApplied) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getGroupSeasonStartMonth(group.id)
      .then((monthHint) => {
        if (cancelled) return;
        setSsm(monthHint);
        const y = resolveSeedYear(monthHint);
        const { start, end } = computeDefaults(y, monthHint);
        setYear(y);
        setStartDate(start);
        setEndDate(end);
        setDefaultsApplied(true);
      })
      .catch((e) => {
        if (cancelled) return;
        // Soft-fail: no schedule hint → resolveSeedYear yields a
        // today-containing January window (or the chain year if seasons exist).
        const y = resolveSeedYear(null);
        const { start, end } = computeDefaults(y, null);
        setYear(y);
        setStartDate(start);
        setEndDate(end);
        setDefaultsApplied(true);
        setError(`Could not read season_start_month (${e instanceof Error ? e.message : String(e)}); defaulting to January start. Edit the dates if needed.`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, defaultsApplied, defaultYear, group.id]);

  // Esc to cancel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  // When the user changes year, re-default start/end (only if the user
  // hasn't manually edited start_date away from the current default).
  const handleYearChange = (newYear: number) => {
    setYear(newYear);
    // If start_date currently equals the default for the OLD year, replace
    // both. Otherwise leave the user's edits alone.
    const oldDefault = computeDefaults(year, ssm);
    if (startDate === oldDefault.start) {
      const { start, end } = computeDefaults(newYear, ssm);
      setStartDate(start);
      setEndDate(end);
    }
  };

  // When start_date changes, re-default end_date if it currently matches the
  // default for the previous start_date.
  const handleStartDateChange = (newStart: string) => {
    if (startDate && endDate) {
      const endUtc = new Date(startDate + 'T00:00:00Z');
      endUtc.setUTCFullYear(endUtc.getUTCFullYear() + 1);
      endUtc.setUTCDate(endUtc.getUTCDate() - 1);
      const computedOldEnd = endUtc.toISOString().slice(0, 10);
      if (endDate === computedOldEnd) {
        const newStartUtc = new Date(newStart + 'T00:00:00Z');
        const newEndUtc = new Date(newStartUtc.getTime());
        newEndUtc.setUTCFullYear(newEndUtc.getUTCFullYear() + 1);
        newEndUtc.setUTCDate(newEndUtc.getUTCDate() - 1);
        setEndDate(newEndUtc.toISOString().slice(0, 10));
      }
    }
    setStartDate(newStart);
  };

  const canSubmit = !busy && !loading && Boolean(startDate) && Boolean(endDate) && startDate < endDate;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createSeason({
        group_id: group.id,
        start_date: startDate,
        end_date: endDate,
      });
      onSuccess(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create season');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-season-modal-title"
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
      <div
        style={{
          background: '#fff',
          borderRadius: 8,
          maxWidth: 460,
          width: '100%',
          boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 20px',
            background: '#f5f5f5',
            borderBottom: '1px solid #e0e0e0',
          }}
        >
          <h2 id="create-season-modal-title" style={{ margin: 0, fontSize: '1.1rem', color: '#1a1a1a' }}>
            Create Season — {group.name}
          </h2>
        </div>

        <div style={{ padding: 20 }}>
          {loading ? (
            <p style={{ color: '#666', fontSize: 14 }}>Loading defaults…</p>
          ) : (
            <>
              <div style={{ marginBottom: 14 }}>
                <label htmlFor="cs-year" style={labelStyle}>Year *</label>
                <input
                  id="cs-year"
                  type="number"
                  value={year}
                  onChange={(e) => handleYearChange(parseInt(e.target.value, 10) || year)}
                  style={inputStyle}
                  disabled={busy}
                  min={2000}
                  max={2100}
                />
                <div style={hintStyle}>
                  Used as the season's display label (e.g. "{year}").
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label htmlFor="cs-start" style={labelStyle}>Start date *</label>
                <input
                  id="cs-start"
                  type="date"
                  value={startDate}
                  onChange={(e) => handleStartDateChange(e.target.value)}
                  style={inputStyle}
                  disabled={busy}
                />
                <div style={hintStyle}>
                  Defaulted from group's season_start_month
                  {ssm ? ` = ${ssm} (${monthName(ssm)})` : ' (not set; using January)'}
                  . Change end_date will follow start_date by 1 year - 1 day.
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label htmlFor="cs-end" style={labelStyle}>End date *</label>
                <input
                  id="cs-end"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  style={inputStyle}
                  disabled={busy}
                />
              </div>

              {startDate && endDate && startDate >= endDate && (
                <div style={{ ...errorStyle, marginTop: 8 }}>
                  end_date must be after start_date.
                </div>
              )}
            </>
          )}

          {error && (
            <div role="alert" style={{ ...errorStyle, marginTop: 16 }}>
              {error}
            </div>
          )}
        </div>

        <div
          style={{
            padding: '12px 20px',
            background: '#fafafa',
            borderTop: '1px solid #e0e0e0',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="btn"
            style={{
              background: '#0d47a1',
              color: '#fff',
              opacity: canSubmit ? 1 : 0.6,
            }}
          >
            {busy ? 'Creating…' : 'Create Season'}
          </button>
        </div>
      </div>
    </div>
  );
}

function monthName(m: number): string {
  const names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return names[m] ?? String(m);
}

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
  padding: '10px 12px',
  background: '#ffebee',
  color: '#c62828',
  border: '1px solid #f5c6c2',
  borderRadius: 4,
  fontSize: 13,
};
