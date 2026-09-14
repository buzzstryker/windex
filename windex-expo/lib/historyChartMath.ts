/**
 * Pure geometry and data math for the standings History chart.
 *
 * NOTHING in this file imports react, react-native, or react-native-svg. That is
 * load-bearing, not incidental: scripts/history-chart/verify.js compiles this module
 * with `tsc` and exercises it in bare node, so every claim the chart makes about
 * where a pixel lands is testable without a browser or an Expo export. Keep it
 * dependency-free — the moment an RN import lands here, the verification suite
 * stops being runnable and the interpolation bug it exists to catch goes back to
 * being invisible.
 *
 * The component (components/HistoryChart.tsx) owns fetching, state, and rendering,
 * and calls into here for every coordinate it emits.
 */

/* ── Plot geometry ──────────────────────────────────────────────────────────
 * Exported rather than duplicated in the component so the verification path and
 * the render path cannot disagree about the plot rect.
 */
export const CHART_H = 300;
export const PAD_L = 45;
export const PAD_R = 12;
export const PAD_T = 12;
export const PAD_B = 28;

/** Hue slots available to a selection. Not cosmetic — see the palette note below. */
export const MAX_SELECTED = 4;

/**
 * Four categorical slots, validated with dataviz `validate_palette.js` against
 * THIS app's surfaces (light #F5F5F5, dark #151718) under `--pairs all`, because
 * any two highlighted lines can run adjacent anywhere in the plot.
 *
 *   light: worst all-pairs CVD ΔE 16.2 · normal-vision ΔE 19.6 · PASS
 *   dark:  worst all-pairs CVD ΔE  6.9 · normal-vision ΔE 19.3 · PASS (warn band)
 *
 * FOUR, not five: no 5-hue subset of the documented palette clears the
 * normal-vision floor (ΔE >= 15) in both modes — that floor is a hard gate that
 * direct labels do NOT excuse. All 56 five-subsets were enumerated and every one
 * fails. Do not add a fifth slot "since there's room in the array"; re-run the
 * validator first and it will tell you no.
 *
 * The dark run sits in the 6-8 CVD warn band, which is legal ONLY with secondary
 * encoding. The swatch-beside-a-name pairing in the pills and the tooltip IS that
 * encoding. Never reduce either to a bare swatch.
 */
export const CHART_SERIES_LIGHT = ['#eda100', '#e87ba4', '#008300', '#4a3aa7'];
export const CHART_SERIES_DARK = ['#c98500', '#d55181', '#008300', '#9085e9'];

/* ── Types ─────────────────────────────────────────────────────────────────── */

export type ScoreRow = {
  player_id: string;
  score_value: number | null;
  score_override: number | null;
  round_date: string;
};

/** Structural subset of StandingRow — declared locally so this module stays free
 *  of the `@/lib/api` import chain and remains compilable in isolation. */
export type StandingLike = { player_id: string; player_name?: string };

export type LinePoint = { x: number; y: number; date: string };

/** No `color` field. A player's hue is a property of (player, current selection),
 *  not of the series, so it is resolved at render by assignHues(). */
export type PlayerLine = {
  id: string;
  name: string;
  points: LinePoint[];
  /** Fewer than 3 vertices over the WHOLE season. Set once at build time and carried
   *  unchanged into every windowed view, so nearest-5 eligibility is a property of
   *  the player, never of the range. */
  thin: boolean;
  /** Every date this player has a score row, zero-point rounds included. A 0 adds no
   *  vertex, so vertices cannot answer "did this player play in the window". */
  playedDates: string[];
};

export type ChartData = {
  lines: PlayerLine[];
  yMin: number;
  yMax: number;
  /** Union of every round_date carrying a score, ascending. The snap domain. */
  dates: string[];
};

/* ── Dates ─────────────────────────────────────────────────────────────────── */

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LETTERS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Parse 'YYYY-MM-DD' to a local-midnight epoch WITHOUT going through Date's
 *  string parser, which treats a bare date as UTC and shifts the whole season by
 *  a timezone offset west of Greenwich. */
export function dayMs(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

export function isoOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** '2026-03-21' -> '21 Mar' */
export function formatDay(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTH_ABBR[m - 1]}`;
}

/** '2026-03-21' -> '21 Mar 2026' */
export function formatFull(iso: string): string {
  const [y] = iso.split('-').map(Number);
  return `${formatDay(iso)} ${y}`;
}

/* ── X mapping ─────────────────────────────────────────────────────────────── */

/**
 * The ONE date -> normalized-x mapping. x=0 is `start` — the season start, or a
 * range's window start — and x=1 is TODAY (not season end — a season runs a year
 * and we only ever plot up to now).
 *
 * Data vertices, month gridlines and day gridlines all go through this. That
 * sharing is the fix for the tick drift: the ticks used to be laid out evenly at
 * (i+1)/(elapsedMonths+1) while vertices were placed calendar-proportionally, so
 * they disagreed by a growing margin (for the 2025-12-01 season the "J" tick sat
 * at 0.111 against Jan 1's true 0.1225). Days are not equal widths either: across
 * a daylight-saving change one is 23h or 25h long. Do not reintroduce a second
 * mapping.
 */
export function makeToX(start: string, todayIso: string): (date: string) => number {
  const startTs = dayMs(start);
  const range = dayMs(todayIso) - startTs || 1;
  return (date: string) => Math.max(0, Math.min(1, (dayMs(date) - startTs) / range));
}

/* ── Scales ────────────────────────────────────────────────────────────────── */

export type Scales = {
  toSvgX: (nx: number) => number;
  toSvgY: (val: number) => number;
  /**
   * toSvgY clamped to the plot rect. Everything drawn from a series value goes
   * through this — polylines and crosshair dots — while gridlines keep toSvgY.
   *
   * A windowed y-domain covers only the players who played in the window, so a
   * player parked far outside it must pin to the floor or ceiling. Coordinate
   * clamping, NOT <ClipPath>: clipping to the plot rect deletes a line lying wholly
   * outside it, which is the opposite of pinning. Clamping vertices would bend any
   * segment that crosses the boundary, but none can: every line able to leave a
   * windowed domain is wholly horizontal (see windowChartData). In Season the
   * domain covers every line and this is the identity.
   */
  plotY: (val: number) => number;
  plotW: number;
  plotH: number;
};

export function makeScales(svgWidth: number, yMin: number, yMax: number): Scales {
  const plotW = Math.max(1, svgWidth - PAD_L - PAD_R);
  const plotH = CHART_H - PAD_T - PAD_B;
  const span = yMax - yMin || 1;
  const toSvgY = (val: number) => PAD_T + (1 - (val - yMin) / span) * plotH;
  return {
    plotW,
    plotH,
    toSvgX: (nx: number) => PAD_L + nx * plotW,
    toSvgY,
    plotY: (val: number) => Math.min(PAD_T + plotH, Math.max(PAD_T, toSvgY(val))),
  };
}

/* ── Build ─────────────────────────────────────────────────────────────────── */

export function buildChartData(
  scores: ScoreRow[],
  standings: StandingLike[],
  seasonStart: string,
  todayIso: string,
): ChartData {
  const playerIds = standings.map((s) => s.player_id);
  const known = new Set(playerIds);

  // Sum score deltas per (date, player). Several rounds can share a date — up to
  // seven for one player in the live Windex Cup data — and they collapse into a
  // single vertex, so the x domain is dates, never round ids.
  const deltasByDate = new Map<string, Map<string, number>>();
  for (const s of scores) {
    if (!known.has(s.player_id)) continue;
    const pts = s.score_override ?? s.score_value ?? 0;
    const dateMap = deltasByDate.get(s.round_date) ?? new Map<string, number>();
    dateMap.set(s.player_id, (dateMap.get(s.player_id) ?? 0) + pts);
    deltasByDate.set(s.round_date, dateMap);
  }

  const dates = [...deltasByDate.keys()].sort();
  const toX = makeToX(seasonStart, todayIso);

  // The zero seed stays for Season: every Season line starts at the y=0
  // season-start vertex, so zero is in the data regardless, and the seed only
  // decides the domain when no series has a vertex at all. windowChartData must
  // NOT copy it — a window whose field sits at 250-400 would get an axis from -40.
  let yMin = 0;
  let yMax = 0;

  const lines: PlayerLine[] = playerIds.map((pid, i) => {
    const points: LinePoint[] = [{ x: 0, y: 0, date: seasonStart }];
    const playedDates: string[] = [];
    let cumulative = 0;

    for (const date of dates) {
      const day = deltasByDate.get(date);
      if (day?.has(pid)) playedDates.push(date);
      const delta = day?.get(pid) ?? 0;
      if (delta !== 0) {
        cumulative += delta;
        points.push({ x: toX(date), y: cumulative, date });
      }
    }

    const name = standings[i]?.player_name ?? pid.slice(0, 8);
    const thin = points.length < 3;
    if (points.length <= 1) return { id: pid, name, points: [], thin, playedDates };

    for (const p of points) {
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }
    return { id: pid, name, points, thin, playedDates };
  });

  // Padded domain, computed over ALL lines. Selection is not an input here and
  // must never become one — highlight-not-hide exists so the y-scale holds still
  // while the user compares, and that guarantee is structural exactly because
  // this function cannot see the selection.
  const pad = Math.max(10, Math.round((yMax - yMin) * 0.1));
  return { lines, yMin: yMin - pad, yMax: yMax + pad, dates };
}

export function activeLinesOf(data: ChartData | null): PlayerLine[] {
  return data?.lines.filter((l) => l.points.length > 0) ?? [];
}

/* ── Ranges ────────────────────────────────────────────────────────────────── */

export type RangeKey = 'season' | 'd10' | 'd4';
export const RANGE_DAYS = { d10: 10, d4: 4 } as const;
export type WindowKey = keyof typeof RANGE_DAYS;

/** today − days, by CALENDAR subtraction. Never ms arithmetic: across a
 *  daylight-saving change that lands an hour off midnight, on the wrong date. */
export function windowStartOf(todayIso: string, days: number): string {
  const d = new Date(dayMs(todayIso));
  d.setDate(d.getDate() - days);
  return isoOf(d);
}

/** Whether (windowStart, today] holds any scored round. Reads the dates the chart
 *  already fetched, so disabling an empty range costs no request. */
export function rangeHasRounds(dates: string[], windowStart: string, todayIso: string): boolean {
  return dates.some((d) => d > windowStart && d <= todayIso);
}

/**
 * The season chart CROPPED to (windowStart, today]. Not rebased: every value is
 * still cumulative season points, so a date reads the same number in Season and
 * in any window.
 *
 *   x=0  windowStart, carrying the standings after that day's rounds
 *   x=1  today
 *
 * Per line:
 *   entry   the Season line's own value at the window edge — interpolated where
 *           Season draws a diagonal, because that IS the pixel Season shows there.
 *           A line that ended before the window holds its last value.
 *   body    the Season vertices inside the window, re-mapped. slice(1) skips the
 *           season-start vertex, which is not a round.
 *   hold    a flat vertex at x=1. A player who stopped playing held their place,
 *           and that is information, so no line ENDS inside a window — the
 *           "ended · last X" tooltip row belongs to Season.
 *
 * No vertex but the entry sits at x=0 (body dates are > windowStart), so no line
 * draws a vertical stroke up the left edge — which is exactly what swapping in a
 * windowed toX over Season points would do, because makeToX clamps.
 *
 * y-domain: over the players with a score row IN the window, seeded from their
 * points, never from zero. Every other line has no in-window vertex, so it is
 * [entry, hold] at one y: wholly horizontal, which is what makes clamping it to the
 * floor or ceiling exact (see Scales.plotY).
 *
 * Takes no selection, like buildChartData: RANGE moves the axis, SELECTION never does.
 */
export function windowChartData(
  data: ChartData,
  seasonStart: string,
  windowStart: string,
  todayIso: string,
): ChartData {
  const seasonToX = makeToX(seasonStart, todayIso);
  const toX = makeToX(windowStart, todayIso);
  const inWindow = (d: string) => d > windowStart && d <= todayIso;
  const entryNx = seasonToX(windowStart);

  const lines = data.lines.map((line): PlayerLine => {
    if (line.points.length === 0) return line;
    const entry = valueAt(line.points, entryNx) ?? line.points[line.points.length - 1].y;
    const points: LinePoint[] = [{ x: 0, y: entry, date: windowStart }];
    for (const p of line.points.slice(1)) {
      if (inWindow(p.date)) points.push({ x: toX(p.date), y: p.y, date: p.date });
    }
    const last = points[points.length - 1];
    if (last.x < 1) points.push({ x: 1, y: last.y, date: todayIso });
    return { ...line, points };
  });

  const source = lines.filter((l) => l.points.length > 0 && l.playedDates.some(inWindow));
  // Unreachable through buildChartData: an enabled range has a scored date in the
  // window, and that same score row puts its player in `source`. A hand-built
  // ChartData can still get here, and an empty source must not yield ±Infinity.
  const over = source.length > 0 ? source : lines;

  let lo = Infinity;
  let hi = -Infinity;
  for (const l of over) {
    for (const p of l.points) {
      if (p.y < lo) lo = p.y;
      if (p.y > hi) hi = p.y;
    }
  }
  if (lo > hi) {
    lo = 0;
    hi = 0;
  }
  lo = Math.floor(lo);
  hi = Math.ceil(hi);
  const pad = Math.max(10, Math.round((hi - lo) * 0.1));
  return { lines, yMin: lo - pad, yMax: hi + pad, dates: data.dates.filter(inWindow) };
}

/* ── Value lookup ──────────────────────────────────────────────────────────── */

/**
 * Value of a series at normalized x, by LINEAR INTERPOLATION between the
 * bracketing vertices of that series' own polyline.
 *
 * NOT carry-forward of the last vertex. The <Polyline> draws straight segments
 * between exactly these vertices, so interpolation IS the pixel under the
 * crosshair; carry-forward would be a step function the chart never draws, and
 * the tooltip would confidently report a number that disagrees with the line the
 * user is looking at. V1 compares this against the emitted `points` string and
 * fails loudly if anyone "simplifies" it back.
 *
 * Returns null past the series' last vertex: the polyline ENDS there, so there is
 * no drawn pixel to report. Callers decide what an ended series looks like.
 */
export function valueAt(points: LinePoint[], nx: number): number | null {
  if (points.length === 0) return null;
  if (nx <= points[0].x) return points[0].y;
  const last = points[points.length - 1];
  if (nx > last.x) return null;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (nx >= a.x && nx <= b.x) {
      const span = b.x - a.x;
      const t = span === 0 ? 0 : (nx - a.x) / span;
      return a.y + t * (b.y - a.y);
    }
  }
  return last.y;
}

/** The coordinate string handed to <Polyline points={...}>. Exported so the
 *  verification script reads the very string the SVG renders, rather than a
 *  reimplementation of it. */
export function polylinePoints(line: PlayerLine, s: Scales): string {
  return line.points.map((p) => `${s.toSvgX(p.x)},${s.plotY(p.y)}`).join(' ');
}

/* ── Snapping ──────────────────────────────────────────────────────────────── */

/**
 * Nearest snap date to a pixel x, measured in SCREEN distance rather than
 * normalized-x distance. Same ranking today, and it stays correct if the plot
 * padding ever changes.
 *
 * `dates` must already be limited to what `toX` spans. makeToX clamps, so a date
 * outside a window lands on its edge and can win the snap there.
 */
export function nearestDate(dates: string[], toX: (d: string) => number, s: Scales, pxX: number): string | null {
  if (dates.length === 0) return null;
  let best = dates[0];
  let bestD = Infinity;
  for (const d of dates) {
    const dist = Math.abs(s.toSvgX(toX(d)) - pxX);
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}

/* ── Hue assignment ────────────────────────────────────────────────────────── */

/**
 * Map each SELECTED player to a palette slot.
 *
 * Preference is keyed on a lexicographic sort of player_id — stable across
 * standings movement and across seasons, so a player keeps their color as they
 * climb or fall. (The old code keyed on standings POSITION, which repainted the
 * whole chart every time anyone overtook anyone.)
 *
 * With 12 players and 4 slots collisions are unavoidable, so a taken slot walks to
 * the next free one. Iterating the selection in the same sorted order makes the
 * result depend only on the SET of selected players, never on click order:
 * selecting A then B gives exactly what B then A gives.
 */
export function assignHues(allIds: string[], selectedIds: string[]): Map<string, number> {
  const sorted = [...allIds].sort();
  const sel = [...selectedIds].sort();
  const taken = new Set<number>();
  const out = new Map<string, number>();

  for (const id of sel) {
    const idx = sorted.indexOf(id);
    if (idx < 0) continue;
    let slot = idx % MAX_SELECTED;
    for (let k = 0; k < MAX_SELECTED && taken.has(slot); k++) {
      slot = (slot + 1) % MAX_SELECTED;
    }
    taken.add(slot);
    out.set(id, slot);
  }
  return out;
}

/* ── Axis ticks ────────────────────────────────────────────────────────────── */

export function niceTickValues(min: number, max: number, count: number): number[] {
  const range = max - min || 1;
  const roughStep = range / (count - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const options = [1, 2, 5, 10];
  let step = options[0] * magnitude;
  for (const o of options) {
    if (o * magnitude >= roughStep) {
      step = o * magnitude;
      break;
    }
  }
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.01; v += step) ticks.push(Math.round(v));
  return ticks;
}

/** An x-axis tick. `anchor` defaults to 'middle'; an empty label draws the
 *  gridline only. */
export type MonthTick = { nx: number; label: string; anchor?: 'middle' | 'end' };

/**
 * First-of-month ticks placed through toX — the SAME mapping the vertices use.
 *
 * The label is read off the tick's own date rather than derived by arithmetic on
 * the start month, which is what makes it correct across the year boundary every
 * Windex Cup season crosses (they start December 1).
 */
export function buildMonthTicks(seasonStart: string, todayIso: string, toX: (d: string) => number): MonthTick[] {
  const start = new Date(dayMs(seasonStart));
  const today = new Date(dayMs(todayIso));
  const elapsed = Math.max(
    1,
    (today.getFullYear() - start.getFullYear()) * 12 + (today.getMonth() - start.getMonth()),
  );
  const ticks: MonthTick[] = [];
  for (let m = 1; m <= elapsed; m++) {
    const d = new Date(start.getFullYear(), start.getMonth() + m, 1);
    ticks.push({ nx: toX(isoOf(d)), label: MONTH_LETTERS[d.getMonth()] });
  }
  return ticks;
}

/**
 * One tick per calendar day from today − days to today, each placed at
 * toX(thatDay) — the SAME toX windowChartData places vertices with, so a round
 * sits exactly on its day's gridline, including across a 23h or 25h DST day that
 * an even i/days spacing would get wrong.
 *
 *   rightmost        'Today', right-aligned (centred, it would clip at the SVG edge)
 *   up to 4 days     every day, 'Fri 7' — a trip is remembered by weekday
 *   longer           every other day counting back from Today, as a bare day
 *                    number with 'd Mon' on the leftmost label and on the first
 *                    label in a new month. At 10 days a day is ~31px, and a
 *                    right-aligned 'Today' is ~30px wide: labelling every day
 *                    collides with it.
 */
export function buildDayTicks(todayIso: string, days: number, toX: (d: string) => number): MonthTick[] {
  const everyDay = days <= 4;
  const ticks: MonthTick[] = [];
  let labelledMonth = -1;

  for (let back = days; back >= 0; back--) {
    const iso = windowStartOf(todayIso, back);
    const nx = toX(iso);
    if (back === 0) {
      ticks.push({ nx, label: 'Today', anchor: 'end' });
      continue;
    }
    const d = new Date(dayMs(iso));
    let label = '';
    if (everyDay) {
      label = `${WEEKDAY_ABBR[d.getDay()]} ${d.getDate()}`;
    } else if (back % 2 === 0) {
      label = d.getMonth() === labelledMonth ? String(d.getDate()) : `${d.getDate()} ${MONTH_ABBR[d.getMonth()]}`;
      labelledMonth = d.getMonth();
    }
    ticks.push({ nx, label });
  }
  return ticks;
}

/* ── Tooltip rows ──────────────────────────────────────────────────────────── */

export type TooltipRow = {
  id: string;
  name: string;
  value: number;
  /** True when nx is past this series' last vertex: the line has ENDED and there
   *  is no pixel under the crosshair. Renders muted, with no dot. */
  ended: boolean;
  lastDate?: string;
  /** Pixel y of the crosshair dot, or null for an ended row (no dot drawn). */
  svgY: number | null;
};

export const MAX_TOOLTIP_ROWS = 5;

/** A series only earns a spot in the automatic nearest-5 if it has real shape over
 *  the SEASON (not thin — a 2-vertex line is a straight diagonal across months, and
 *  reporting an interpolated value on it is fabrication) AND has not ended.
 *
 *  Thinness is read from the whole-season line even in a windowed view. A window's
 *  own vertex count is mostly its synthesized entry and hold vertices, and a thin
 *  player's one vertex landing inside the window still puts their entry value on
 *  that fabricated diagonal. */
export function isNearestCandidate(line: PlayerLine, nx: number): boolean {
  return !line.thin && valueAt(line.points, nx) !== null;
}

/**
 * Rows for the tooltip at normalized x.
 *
 *   selection active -> EXACTLY the selected players (<= MAX_SELECTED = 4)
 *   no selection     -> the nearest MAX_TOOLTIP_ROWS series to cursorSvgY
 *
 * Positioned rows come back sorted by svgY ascending, i.e. top-to-bottom in the
 * same order the lines sit under the crosshair. With no selection every line is
 * the same neutral gray, so a swatch cannot identify a row — that spatial ordering
 * plus the crosshair dots is the ONLY thing making five gray rows interpretable.
 * V9 asserts the ordering; do not "tidy" it into alphabetical.
 *
 * Equal svgY breaks by value, highest first: several players parked on a windowed
 * floor share one pixel row, and their true values still have a top-to-bottom
 * order. (In Season equal svgY means equal value, so this never reorders anything.)
 *
 * Ended rows carry no y, so they sort after the positioned ones, by value.
 */
export function buildTooltipRows(
  lines: PlayerLine[],
  nx: number,
  selectedIds: string[],
  cursorSvgY: number,
  s: Scales,
): TooltipRow[] {
  const mk = (line: PlayerLine): TooltipRow | null => {
    const v = valueAt(line.points, nx);
    if (v !== null) {
      return { id: line.id, name: line.name, value: v, ended: false, svgY: s.plotY(v) };
    }
    const last = line.points[line.points.length - 1];
    if (!last) return null;
    return { id: line.id, name: line.name, value: last.y, ended: true, lastDate: last.date, svgY: null };
  };

  let rows: TooltipRow[];

  if (selectedIds.length > 0) {
    const sel = new Set(selectedIds);
    rows = lines.filter((l) => sel.has(l.id)).map(mk).filter((r): r is TooltipRow => r !== null);
  } else {
    let pool = lines.filter((l) => isNearestCandidate(l, nx));
    // Degenerate fallback: a season with a single date makes EVERY series
    // 2-vertex, so the candidate filter empties and the tooltip would render a
    // blank box. Showing a thin dataset beats showing nothing.
    if (pool.length === 0) pool = lines.filter((l) => valueAt(l.points, nx) !== null);

    rows = pool
      .map(mk)
      .filter((r): r is TooltipRow => r !== null)
      .sort((a, b) => Math.abs((a.svgY ?? 0) - cursorSvgY) - Math.abs((b.svgY ?? 0) - cursorSvgY))
      .slice(0, MAX_TOOLTIP_ROWS);
  }

  const positioned = rows
    .filter((r) => !r.ended)
    .sort((a, b) => (a.svgY ?? 0) - (b.svgY ?? 0) || b.value - a.value);
  const ended = rows.filter((r) => r.ended).sort((a, b) => b.value - a.value);
  return [...positioned, ...ended];
}
