/**
 * A season's display name: its name if it has one, else the calendar year of its
 * midpoint — a Windex Cup season runs December to November, so 2025-12-01..2026-11-30
 * is "2026".
 *
 * Its own module, free of imports, because lib/historyChartMath.ts labels All time's
 * seasons with it and that module must stay compilable in bare node (see its header).
 * lib/api re-exports it, so every existing caller is unchanged.
 */
export function seasonLabel(s: { id: string; name?: string | null; start_date: string; end_date: string }): string {
  if (s.name) return s.name;
  if (!s.start_date) return s.id.slice(0, 8);
  const start = new Date(s.start_date + 'T00:00:00');
  const end = s.end_date ? new Date(s.end_date + 'T00:00:00') : start;
  const mid = new Date((start.getTime() + end.getTime()) / 2);
  return String(mid.getFullYear());
}
