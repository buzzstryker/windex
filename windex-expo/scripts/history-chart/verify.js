/**
 * Headless verification for the History chart.
 *
 *   node scripts/history-chart/verify.js        (from windex-expo/)
 *
 *   Season   V1 V2 V3 V5 V7 V9 Hues
 *   Ranges   V1w V2w V3w V7w V9w V13 V-pills V-clamp
 *   All time V-order V1c V2c V3c V7c V9c V13c V-pills-c V-reach
 *   Pins     V12  Season output byte-identical to the pre-ranges commit
 *            V14  Standings toggle styles identical to the pre-extraction commit
 *
 * Runs against the COMPILED lib/historyChartMath.ts — the same module the
 * component renders from — so nothing here is a reimplementation of the thing
 * under test except where independence is the point (V1 path B, the rejected
 * implementations the falsifiers run).
 *
 * Every check that CAN pass vacuously carries a falsifier or regression arm: a
 * rejected implementation it must tell apart, or a coverage count that must be
 * non-zero. A check that cannot fail is not a check.
 *
 * Versioned next to what it checks, and every path below is relative to this
 * file. It used to live outside the repo with an absolute path to the component;
 * the repo moved, V5 threw ENOENT, and V7/V9/Hues silently stopped running for
 * weeks. Do not reintroduce an absolute path.
 *
 * The module is compiled fresh on every run into ./build (gitignored), so the
 * checks can never run against a stale copy of the math. V12 and V14 compile or
 * parse BASELINE_COMMIT out of git the same way, rather than trusting a stored copy.
 *
 * fixture.json is a snapshot of two real leagues taken 2026-08-11, ANONYMIZED
 * before it entered this public repo: player ids and names are replaced, scores,
 * dates and season starts are untouched. Replacement ids preserve the sorted order
 * of the originals, so assignHues (which sorts player_id) behaves identically.
 *
 * fixture.alltime is the same two leagues on the same date, under the same placeholder
 * ids. Per league: every season that existed on 2026-08-11 — including the future one
 * the rollover job had already created, which careerSpans must drop — and the
 * season_standings rows for those seasons, the view body evaluated as of that date.
 * Season ids are synthetic and deliberately NOT in date order. allTimeLeaderboard is
 * the All Time leaderboard as standings.tsx computes it (per-season standings merged
 * over the seasons listSeasons returns). rawScoreTotals is the independent side:
 * league_scores summed per player, with no view and no membership join. The two agreed
 * 12/12 in both leagues when taken, and V13c holds them, and every career line, to it.
 * Totals are untouched, 2021 and 2022 half points included. YC Windex has one season
 * with totals, so it is the league the >= 2 seasons rule disables.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EXPO = path.resolve(__dirname, '..', '..');
const SRC = path.join(EXPO, 'lib', 'historyChartMath.ts');
const COMPONENT = path.join(EXPO, 'components', 'HistoryChart.tsx');
const TOGGLE = path.join(EXPO, 'components', 'SegmentedToggle.tsx');
const STANDINGS = path.join(EXPO, 'app', '(tabs)', 'standings.tsx');
const BUILD = path.join(__dirname, 'build');
const TSC = path.join(EXPO, 'node_modules', 'typescript', 'bin', 'tsc');

/**
 * The last commit before History ranges. V12 holds Season output to it and V14
 * holds the Standings toggle to it. An INTENTIONAL change to either must move this
 * pin in the same commit, with the reason in the message.
 */
const BASELINE_COMMIT = '979b345';

function compile(srcFile, outDir) {
  execFileSync(
    process.execPath,
    [TSC, srcFile, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2020', '--strict', '--skipLibCheck'],
    { stdio: 'pipe' },
  );
  return require(path.join(outDir, 'historyChartMath.js'));
}

function gitShow(repoPath) {
  return execFileSync('git', ['show', `${BASELINE_COMMIT}:${repoPath}`], { cwd: EXPO, encoding: 'utf8', stdio: 'pipe' });
}

let M;
try {
  M = compile(SRC, BUILD);
} catch (e) {
  console.log(`  [FAIL] build — tsc rejected ${path.relative(EXPO, SRC)}:\n${e.stdout || e.message}`);
  process.exit(1);
}

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
const TODAY = '2026-08-11';
const SVG_W = 364; // 380px viewport - container paddingHorizontal 8*2
const FIXTURES = ['windexcup', 'ycwindex'];
const WINDOWS = ['d10', 'd4'];

let failures = 0;
const ok = (name, msg) => console.log(`  [PASS] ${name}${msg ? ' — ' + msg : ''}`);
const bad = (name, msg) => {
  failures++;
  console.log(`  [FAIL] ${name} — ${msg}`);
};
const skip = (name, msg) => console.log(`  [SKIP] ${name} — ${msg}`);

/** A check that throws is a FAIL with its name on it, never an uncaught crash
 *  that takes every later check down with it. */
function run(name, fn) {
  try {
    fn();
  } catch (e) {
    bad(name, `threw: ${e && e.message ? e.message : e}`);
  }
}

function load(key) {
  const f = fixture[key];
  return {
    data: M.buildChartData(f.scores, f.standings, f.seasonStart, TODAY),
    seasonStart: f.seasonStart,
  };
}

/* Shared helpers ─────────────────────────────────────────────────────────── */

/** Interpolate in PIXEL space over an emitted <Polyline points> string. Never
 *  calls valueAt, so it is independent of the value-space path. */
function pixelSpaceLookup(pointsStr, targetX) {
  const pts = pointsStr.split(' ').map((p) => {
    const [x, y] = p.split(',').map(Number);
    return { x, y };
  });
  if (targetX <= pts[0].x) return pts[0].y;
  if (targetX > pts[pts.length - 1].x + 1e-9) return null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (targetX >= a.x && targetX <= b.x) {
      const span = b.x - a.x;
      const t = span === 0 ? 0 : (targetX - a.x) / span;
      return a.y + t * (b.y - a.y);
    }
  }
  return pts[pts.length - 1].y;
}

// The implementation V1 exists to reject.
function carryForward(points, nx) {
  if (points.length === 0) return null;
  let v = points[0].y;
  for (const p of points) {
    if (p.x <= nx) v = p.y;
  }
  return nx > points[points.length - 1].x ? null : v;
}

const sc = (player_id, score_value, round_date) => ({ player_id, score_value, score_override: null, round_date });
const people = (n) => Array.from({ length: n }, (_, i) => ({ player_id: `p${i}`, player_name: `P${i}` }));

/** A fixture window, built exactly as the component builds it. */
function windowCase(key, rk) {
  const f = fixture[key];
  const season = M.buildChartData(f.scores, f.standings, f.seasonStart, TODAY);
  const days = M.RANGE_DAYS[rk];
  const ws = M.windowStartOf(TODAY, days);
  const enabled = M.rangeHasRounds(season.dates, ws, TODAY);
  return {
    key,
    rk,
    days,
    ws,
    seasonStart: f.seasonStart,
    season,
    enabled,
    data: enabled ? M.windowChartData(season, f.seasonStart, ws, TODAY) : null,
    toX: M.makeToX(ws, TODAY),
    inWindow: (d) => d > ws && d <= TODAY,
  };
}

/** Enabled fixture windows. A zero-round window is disabled in the UI, so it is
 *  SKIPPED, never tested — and too many skips hollow the matrix out, which fails. */
function enabledWindows(check) {
  const out = [];
  for (const key of FIXTURES) {
    for (const rk of WINDOWS) {
      const c = windowCase(key, rk);
      if (c.enabled) out.push(c);
      else skip(`${check} ${key} ${rk}`, `zero rounds in (${c.ws}, ${TODAY}] — option is disabled in the UI`);
    }
  }
  if (out.length < 3) bad(`${check} matrix`, `only ${out.length} windows ran — hollowed out by skips`);
  return out;
}

/* ── V1 ── Interpolation matches the rendered pixel ────────────────────────────
 * Path A: toSvgY(valueAt(series, nx))       value space -> pixel
 * Path B: parse the emitted <Polyline points="..."> string and interpolate in
 *         PIXEL space. Path B never calls valueAt and reads only the string the
 *         SVG is actually built from, so the two are independent.
 */
function v1(key) {
  const { data, seasonStart } = load(key);
  const toX = M.makeToX(seasonStart, TODAY);
  const s = M.makeScales(SVG_W, data.yMin, data.yMax);
  const lines = M.activeLinesOf(data);

  let compared = 0;
  let worst = 0;
  let carryDisagreements = 0;

  for (const line of lines) {
    const str = M.polylinePoints(line, s);
    for (const d of data.dates) {
      const nx = toX(d);
      const v = M.valueAt(line.points, nx);
      if (v === null) continue;
      const A = s.toSvgY(v);
      const B = pixelSpaceLookup(str, s.toSvgX(nx));
      if (B === null) {
        bad('V1', `path B found no segment for ${line.name} @ ${d}`);
        return;
      }
      const delta = Math.abs(A - B);
      if (delta > worst) worst = delta;
      compared++;

      const cf = carryForward(line.points, nx);
      if (cf !== null && Math.abs(s.toSvgY(cf) - B) > 0.5) carryDisagreements++;
    }
  }

  if (worst >= 0.5) {
    bad('V1 ' + key, `worst |A-B| = ${worst.toFixed(4)}px over ${compared} comparisons`);
  } else {
    ok('V1 ' + key, `${compared} comparisons, worst |A-B| = ${worst.toFixed(6)}px`);
  }

  // The falsifier: if carry-forward agreed everywhere, V1 could not tell the two
  // implementations apart and would be worthless as a guard.
  if (carryDisagreements === 0) {
    bad('V1 falsifier ' + key, 'carry-forward agreed everywhere — V1 does not discriminate');
  } else {
    ok('V1 falsifier ' + key, `carry-forward disagrees at ${carryDisagreements} points (test discriminates)`);
  }
}

/* ── V1w ── Interpolation matches the rendered pixel, EVERY pixel column ──────
 * In a window the snap dates are few, and carry-forward disagreed at only 5 / 1 / 0
 * of them — too weak a falsifier to trust. Sweeping every column is what makes the
 * windowed V1 able to fail. Path A goes through plotY, because clamped lines are
 * emitted clamped and path B reads the emitted string.
 */
function v1w() {
  let clampedLines = 0;
  for (const c of enabledWindows('V1w')) {
    const s = M.makeScales(SVG_W, c.data.yMin, c.data.yMax);
    const lines = M.activeLinesOf(c.data);
    let compared = 0;
    let worst = 0;
    let carryDis = 0;
    let gaps = 0;
    for (const line of lines) {
      if (line.points.some((p) => p.y < c.data.yMin || p.y > c.data.yMax)) clampedLines++;
      const str = M.polylinePoints(line, s);
      for (let px = 0; px <= s.plotW; px++) {
        const nx = px / s.plotW;
        const v = M.valueAt(line.points, nx);
        const B = pixelSpaceLookup(str, s.toSvgX(nx));
        // Holds mean every windowed line spans [0, 1]: a gap is a line that ENDED.
        if (v === null || B === null) {
          gaps++;
          continue;
        }
        worst = Math.max(worst, Math.abs(s.plotY(v) - B));
        compared++;
        const cf = carryForward(line.points, nx);
        if (cf !== null && Math.abs(s.plotY(cf) - B) > 0.5) carryDis++;
      }
    }
    const name = `V1w ${c.key} ${c.rk}`;
    if (worst < 0.5 && gaps === 0) ok(name, `${compared} column comparisons, worst |A-B| = ${worst.toFixed(6)}px, no gaps`);
    else bad(name, `worst |A-B| = ${worst.toFixed(4)}px, ${gaps} columns with no value (a line ended inside the window)`);
    if (carryDis > 0) ok(name + ' falsifier', `carry-forward disagrees at ${carryDis} columns (test discriminates)`);
    else bad(name + ' falsifier', 'carry-forward agreed at every column — V1w does not discriminate');
  }
  if (clampedLines > 0) ok('V1w clamp coverage', `${clampedLines} clamped lines went through the pixel comparison`);
  else bad('V1w clamp coverage', 'no line was clamped anywhere in the matrix — clamping not exercised');
}

/* ── V2 ── y-domain invariance under selection ─────────────────────────────── */
function v2(key) {
  const { data } = load(key);
  const lines = M.activeLinesOf(data);
  const ids = lines.map((l) => l.id);

  const selections = [
    [],
    [ids[0]],
    [ids[1]],
    [ids[ids.length - 1]],
    ids.slice(0, 2),
    ids.slice(0, M.MAX_SELECTED),
  ];

  // Reproduce the component's render path for each selection state and read back
  // the domain it would scale with.
  const domains = selections.map((sel) => {
    const hues = M.assignHues(ids, sel); // exercised, must not feed the domain
    void hues;
    const s = M.makeScales(SVG_W, data.yMin, data.yMax);
    return [data.yMin, data.yMax, s.toSvgY(0), s.toSvgY(100)].join('|');
  });

  const allSame = domains.every((d) => d === domains[0]);
  if (allSame) ok('V2 ' + key, `domain [${data.yMin}, ${data.yMax}] identical across ${selections.length} selection states`);
  else bad('V2 ' + key, `domain moved: ${JSON.stringify(domains)}`);

  // buildChartData structurally cannot see a selection — assert the signature.
  if (M.buildChartData.length === 4) ok('V2 signature', 'buildChartData takes no selection argument');
  else bad('V2 signature', `buildChartData arity ${M.buildChartData.length}, expected 4`);
}

/* ── V2w ── RANGE moves the axis, SELECTION never does ─────────────────────── */
function v2w() {
  for (const key of FIXTURES) {
    const season = load(key).data;
    const ids = M.activeLinesOf(season).map((l) => l.id);
    const selections = [[], [ids[0]], [ids[1]], [ids[ids.length - 1]], ids.slice(0, 2), ids.slice(0, M.MAX_SELECTED)];
    const byRange = { season };
    for (const rk of WINDOWS) {
      const c = windowCase(key, rk);
      if (c.enabled) byRange[rk] = c.data;
      else skip(`V2w ${key} ${rk}`, 'zero rounds in window — option is disabled in the UI');
    }
    for (const [rk, data] of Object.entries(byRange)) {
      const domains = selections.map((sel) => {
        void M.assignHues(ids, sel);
        const s = M.makeScales(SVG_W, data.yMin, data.yMax);
        return [data.yMin, data.yMax, s.toSvgY(0), s.plotY(100)].join('|');
      });
      if (domains.every((d) => d === domains[0])) {
        ok(`V2w selection ${key} ${rk}`, `domain [${data.yMin}, ${data.yMax}] identical across ${selections.length} selection states`);
      } else {
        bad(`V2w selection ${key} ${rk}`, `domain moved with selection: ${JSON.stringify(domains)}`);
      }
    }
    if (key === 'windexcup') {
      for (const rk of WINDOWS) {
        const w = byRange[rk];
        if (!w) {
          bad(`V2w range ${key} ${rk}`, 'window unexpectedly disabled on the fixture');
        } else if (w.yMin === season.yMin && w.yMax === season.yMax) {
          bad(`V2w range ${key} ${rk}`, `windowed domain equals Season [${season.yMin}, ${season.yMax}] — window not recomputing`);
        } else {
          ok(`V2w range ${key} ${rk}`, `axis moved: Season [${season.yMin}, ${season.yMax}] -> [${w.yMin}, ${w.yMax}]`);
        }
      }
    }
  }

  if (M.windowChartData.length === 4) ok('V2w signature', 'windowChartData takes no selection argument');
  else bad('V2w signature', `windowChartData arity ${M.windowChartData.length}, expected 4`);

  // Zero-seed arm. A league whose in-window field sits at 250-400: a data-seeded
  // window axis must sit wholly above zero, while Season (from-zero lines) keeps 0.
  const pts = [];
  const ladder = [260, 300, 340, 380];
  ladder.forEach((target, i) => {
    pts.push(sc(`p${i}`, target - 20, '2026-06-01'));
    pts.push(sc(`p${i}`, 20, '2026-08-09'));
    pts.push(sc(`p${i}`, (i % 2 ? 1 : -1) * 7, '2026-08-10'));
  });
  const season = M.buildChartData(pts, people(4), '2026-01-01', TODAY);
  const ws = M.windowStartOf(TODAY, 4);
  const w = M.windowChartData(season, '2026-01-01', ws, TODAY);
  // What a zero-seeded window would have produced, to prove this arm can fail.
  let zlo = 0;
  let zhi = 0;
  for (const l of w.lines) for (const p of l.points) { zlo = Math.min(zlo, p.y); zhi = Math.max(zhi, p.y); }
  const zeroSeededMin = zlo - Math.max(10, Math.round((zhi - zlo) * 0.1));
  if (w.yMin > 0 && season.yMin <= 0 && zeroSeededMin <= 0) {
    ok('V2w zero-seed', `window [${w.yMin}, ${w.yMax}] sits above 0; Season [${season.yMin}, ${season.yMax}] keeps it; a zero seed would give ${zeroSeededMin}`);
  } else {
    bad('V2w zero-seed', `window yMin ${w.yMin} (want > 0), Season yMin ${season.yMin} (want <= 0), zero-seeded ${zeroSeededMin} (want <= 0)`);
  }
}

/* ── V3 ── Month ticks sit on the data's own mapping ───────────────────────── */
function v3(key) {
  const { seasonStart } = load(key);
  const toX = M.makeToX(seasonStart, TODAY);
  const ticks = M.buildMonthTicks(seasonStart, TODAY, toX);

  const start = new Date(M.dayMs(seasonStart));
  let exact = true;
  ticks.forEach((t, i) => {
    const d = new Date(start.getFullYear(), start.getMonth() + i + 1, 1);
    if (t.nx !== toX(M.isoOf(d))) exact = false;
  });
  if (exact) ok('V3 ' + key, `${ticks.length} ticks, all nx === toX(firstOfMonth) exactly`);
  else bad('V3 ' + key, 'a tick does not sit on toX()');

  // Regression guard: the old even-spacing formula must DISAGREE, otherwise this
  // test would not have caught the bug it was written for.
  let maxDrift = 0;
  ticks.forEach((t, i) => {
    maxDrift = Math.max(maxDrift, Math.abs(t.nx - (i + 1) / (ticks.length + 1)));
  });
  if (maxDrift > 0.005) ok('V3 regression ' + key, `old even-spacing formula drifts up to ${maxDrift.toFixed(4)} nx`);
  else bad('V3 regression ' + key, `old formula drift only ${maxDrift.toFixed(5)} — test would not have caught it`);
}

/* ── V3w ── Day ticks sit on the data's own mapping, DST included ──────────── */

/** Problems with the day ticks for (today, days) in the CURRENT process timezone.
 *  Alignment is checked against vertices windowChartData actually placed, not
 *  against a second call to toX. Returns the i/days drift for the regression arm. */
function dayTickProblems(today, days) {
  const problems = [];
  const ws = M.windowStartOf(today, days);
  const toX = M.makeToX(ws, today);
  const ticks = M.buildDayTicks(today, days, toX);

  if (ticks.length !== days + 1) problems.push(`${ticks.length} ticks, want ${days + 1}`);
  if (ticks[0].nx !== 0) problems.push(`first nx ${ticks[0].nx}`);
  const last = ticks[ticks.length - 1];
  if (last.nx !== 1 || last.label !== 'Today' || last.anchor !== 'end') problems.push(`last tick ${JSON.stringify(last)}`);

  // One player scoring every day of the window.
  const scores = [];
  for (let back = days - 1; back >= 0; back--) scores.push(sc('p0', 1, M.windowStartOf(today, back)));
  scores.push(sc('p1', 5, M.windowStartOf(today, days + 3)));
  const seasonStart = M.windowStartOf(today, 60);
  const season = M.buildChartData(scores, people(2), seasonStart, today);
  const w = M.windowChartData(season, seasonStart, ws, today);
  const line = w.lines.find((l) => l.id === 'p0');

  let drift = 0;
  let labelled = 0;
  let labelledMonth = -1;
  ticks.forEach((t, i) => {
    const back = days - i;
    const iso = M.windowStartOf(today, back);
    if (t.nx !== toX(iso)) problems.push(`tick ${iso}: nx ${t.nx} !== toX ${toX(iso)}`);
    if (back > 0) {
      const v = line.points.find((p) => p.date === iso);
      if (!v) problems.push(`no vertex placed for ${iso}`);
      else if (v.x !== t.nx) problems.push(`vertex ${iso} x ${v.x} !== tick nx ${t.nx}`);
    }
    drift = Math.max(drift, Math.abs(t.nx - i / days));

    if (back === 0) return;
    const d = new Date(M.dayMs(iso));
    if (days <= 4) {
      if (!/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}$/.test(t.label) || !t.label.endsWith(` ${d.getDate()}`)) {
        problems.push(`4-day label ${JSON.stringify(t.label)} for ${iso}`);
      }
    } else if (back % 2 === 0) {
      labelled++;
      const want = d.getMonth() === labelledMonth ? String(d.getDate()) : new RegExp(`^${d.getDate()} [A-Z][a-z]{2}$`);
      labelledMonth = d.getMonth();
      if (typeof want === 'string' ? t.label !== want : !want.test(t.label)) problems.push(`10-day label ${JSON.stringify(t.label)} for ${iso}`);
    } else if (t.label !== '') {
      problems.push(`10-day tick ${iso} should be unlabelled, got ${JSON.stringify(t.label)}`);
    }
  });
  if (days > 4 && labelled !== Math.floor(days / 2)) problems.push(`${labelled} labelled days, want ${Math.floor(days / 2)}`);
  return { problems, drift };
}

function v3w() {
  for (const days of [4, 10]) {
    const { problems } = dayTickProblems(TODAY, days);
    if (problems.length === 0) ok(`V3w ${days} days`, `${days + 1} ticks on toX exactly, each round's vertex on its day's tick, labels per rule`);
    else bad(`V3w ${days} days`, problems.slice(0, 4).join('; '));
  }

  // DST. process.env.TZ is set IN-PROCESS: Git Bash strips TZ=America/... from a
  // command line before node starts, so a TZ set outside can silently not apply.
  // The precondition catches exactly that.
  const cases = [
    { tz: 'America/Los_Angeles', today: '2026-11-03', days: 4, dstDay: '2026-11-01', hours: 25 },
    { tz: 'America/Los_Angeles', today: '2026-11-06', days: 10, dstDay: '2026-11-01', hours: 25 },
    { tz: 'America/Los_Angeles', today: '2026-03-10', days: 4, dstDay: '2026-03-08', hours: 23 },
    { tz: 'Europe/London', today: '2026-10-27', days: 4, dstDay: '2026-10-25', hours: 25 },
    { tz: 'Asia/Tokyo', today: '2026-11-03', days: 4, dstDay: '2026-11-01', hours: 24 },
  ];
  // Restore by NAME. `delete process.env.TZ` does not reset node's zone cache — the
  // first version of this check did that and stayed in Asia/Tokyo afterwards.
  const savedTz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offsetBefore = new Date(2026, 6, 1).getTimezoneOffset();
  try {
    for (const c of cases) {
      process.env.TZ = c.tz;
      const name = `V3w DST ${c.tz} ${c.dstDay} ${c.days}d`;
      const measured = (M.dayMs(M.windowStartOf(c.dstDay, -1)) - M.dayMs(c.dstDay)) / 36e5;
      if (measured !== c.hours) {
        bad(name, `precondition: ${c.dstDay} measured ${measured}h, want ${c.hours}h — TZ not applied, DST not exercised`);
        continue;
      }
      const { problems, drift } = dayTickProblems(c.today, c.days);
      const expectedStart = { '2026-11-03': '2026-10-30', '2026-11-06': '2026-10-27', '2026-03-10': '2026-03-06', '2026-10-27': '2026-10-23' }[c.today];
      if (M.windowStartOf(c.today, c.days) !== expectedStart) problems.push(`windowStartOf ${M.windowStartOf(c.today, c.days)}, want ${expectedStart}`);
      if (problems.length === 0) ok(name, `${c.hours}h day: ticks and vertices on toX exactly`);
      else bad(name, problems.slice(0, 4).join('; '));

      // Regression arm: even i/days spacing must be WRONG across a DST day (else
      // this could not catch a second mapping) and exact without one.
      if (c.hours !== 24) {
        if (drift > 1e-4) ok(name + ' regression', `even i/days spacing would drift ${drift.toFixed(5)} nx`);
        else bad(name + ' regression', `even spacing drift only ${drift} — test would not catch a second mapping`);
      } else if (drift < 1e-12) {
        ok(name + ' control', 'no DST day: even spacing and toX agree exactly');
      } else {
        bad(name + ' control', `drift ${drift} with no DST day`);
      }
    }
  } finally {
    process.env.TZ = savedTz;
  }
  const offsetAfter = new Date(2026, 6, 1).getTimezoneOffset();
  if (offsetAfter === offsetBefore) ok('V3w TZ restored', `offset back to ${offsetAfter} min`);
  else bad('V3w TZ restored', `offset ${offsetAfter}, was ${offsetBefore} — later checks run in the wrong zone`);
}

/* ── V5 ── No literal hex in the component ─────────────────────────────────── */
function v5() {
  if (!fs.existsSync(COMPONENT)) {
    bad('V5', `component not found at ${path.relative(EXPO, COMPONENT)} — nothing was checked`);
    return;
  }
  const src = fs.readFileSync(COMPONENT, 'utf8');
  const hits = src.match(/#[0-9A-Fa-f]{3,8}\b/g) || [];
  if (hits.length === 0) ok('V5', 'no literal hex in HistoryChart.tsx');
  else bad('V5', `literal hex present: ${hits.join(', ')}`);
}

/* ── V7 ── Degenerate states ───────────────────────────────────────────────── */
function v7() {
  const S = (n) => Array.from({ length: n }, (_, i) => ({ player_id: `p${i}`, player_name: `P${i}` }));

  // 0 active lines
  const empty = M.buildChartData([], S(3), '2026-01-01', TODAY);
  if (M.activeLinesOf(empty).length === 0) ok('V7 no-rounds', 'zero active lines');
  else bad('V7 no-rounds', 'expected zero active lines');

  // 1 player
  const one = M.buildChartData(
    [
      { player_id: 'p0', score_value: 3, score_override: null, round_date: '2026-02-01' },
      { player_id: 'p0', score_value: -2, score_override: null, round_date: '2026-03-01' },
      { player_id: 'p0', score_value: 5, score_override: null, round_date: '2026-04-01' },
    ],
    S(1),
    '2026-01-01',
    TODAY,
  );
  const oneLines = M.activeLinesOf(one);
  const oneS = M.makeScales(SVG_W, one.yMin, one.yMax);
  const oneRows = M.buildTooltipRows(oneLines, M.makeToX('2026-01-01', TODAY)('2026-03-01'), [], 150, oneS);
  if (oneLines.length === 1 && oneRows.length === 1) ok('V7 one-player', '1 line, 1 tooltip row');
  else bad('V7 one-player', `lines=${oneLines.length} rows=${oneRows.length}`);

  // 1 date -> every series is 2-vertex -> nearest-5 candidate set empties ->
  // fallback must still produce rows.
  const oneDate = M.buildChartData(
    [
      { player_id: 'p0', score_value: 3, score_override: null, round_date: '2026-02-01' },
      { player_id: 'p1', score_value: -1, score_override: null, round_date: '2026-02-01' },
      { player_id: 'p2', score_value: 7, score_override: null, round_date: '2026-02-01' },
    ],
    S(3),
    '2026-01-01',
    TODAY,
  );
  const odLines = M.activeLinesOf(oneDate);
  const odS = M.makeScales(SVG_W, oneDate.yMin, oneDate.yMax);
  const odNx = M.makeToX('2026-01-01', TODAY)('2026-02-01');
  const anyCandidate = odLines.some((l) => M.isNearestCandidate(l, odNx));
  const odRows = M.buildTooltipRows(odLines, odNx, [], 150, odS);
  if (!anyCandidate && odRows.length === 3) ok('V7 one-date', 'candidate set empty, fallback produced 3 rows');
  else bad('V7 one-date', `anyCandidate=${anyCandidate} rows=${odRows.length} (expected false / 3)`);

  // All flat at zero: pad floor must keep the domain non-degenerate.
  const flat = M.buildChartData(
    [
      { player_id: 'p0', score_value: 0, score_override: null, round_date: '2026-02-01' },
      { player_id: 'p1', score_value: 0, score_override: null, round_date: '2026-02-01' },
    ],
    S(2),
    '2026-01-01',
    TODAY,
  );
  const flatS = M.makeScales(SVG_W, flat.yMin, flat.yMax);
  const flatY = flatS.toSvgY(0);
  if (flat.yMin === -10 && flat.yMax === 10 && Number.isFinite(flatY)) {
    ok('V7 all-flat', `domain [-10, 10], toSvgY(0) = ${flatY} finite`);
  } else {
    bad('V7 all-flat', `domain [${flat.yMin}, ${flat.yMax}] toSvgY(0)=${flatY}`);
  }

  // 2-vertex series: draws, is selectable, but is excluded from nearest-5.
  const two = M.buildChartData(
    [
      { player_id: 'p0', score_value: 4, score_override: null, round_date: '2026-02-01' },
      { player_id: 'p1', score_value: 1, score_override: null, round_date: '2026-02-01' },
      { player_id: 'p1', score_value: 1, score_override: null, round_date: '2026-03-01' },
      { player_id: 'p1', score_value: 1, score_override: null, round_date: '2026-04-01' },
    ],
    S(2),
    '2026-01-01',
    TODAY,
  );
  const twoLines = M.activeLinesOf(two);
  const twoNx = M.makeToX('2026-01-01', TODAY)('2026-03-01');
  const thin = twoLines.find((l) => l.id === 'p0');
  const twoS = M.makeScales(SVG_W, two.yMin, two.yMax);
  const autoRows = M.buildTooltipRows(twoLines, twoNx, [], 150, twoS);
  const selRows = M.buildTooltipRows(twoLines, twoNx, ['p0'], 150, twoS);
  if (
    thin.points.length === 2 &&
    !M.isNearestCandidate(thin, twoNx) &&
    !autoRows.some((r) => r.id === 'p0') &&
    selRows.some((r) => r.id === 'p0')
  ) {
    ok('V7 two-vertex', 'drawn, excluded from nearest-5, shown when explicitly selected');
  } else {
    bad('V7 two-vertex', `pts=${thin.points.length} auto=${autoRows.map((r) => r.id)} sel=${selRows.map((r) => r.id)}`);
  }

  // Ended series: past its last vertex it leaves the nearest-5, and if selected
  // renders as an ended row with no dot.
  const endedNx = M.makeToX('2026-01-01', TODAY)('2026-06-01');
  const endedAuto = M.buildTooltipRows(twoLines, endedNx, [], 150, twoS);
  const endedSel = M.buildTooltipRows(twoLines, endedNx, ['p1'], 150, twoS);
  const r = endedSel.find((x) => x.id === 'p1');
  if (endedAuto.length === 0 && r && r.ended && r.svgY === null && r.lastDate === '2026-04-01') {
    ok('V7 ended-series', `excluded from auto; selected row ended, no dot, last ${r.lastDate}`);
  } else {
    bad('V7 ended-series', `auto=${endedAuto.length} row=${JSON.stringify(r)}`);
  }
}

/* ── V7w ── Degenerate windows ─────────────────────────────────────────────── */

function strokes(lines) {
  let n = 0;
  for (const l of lines) {
    for (let i = 1; i < l.points.length; i++) {
      if (l.points[i].x === l.points[i - 1].x && l.points[i].y !== l.points[i - 1].y) n++;
    }
  }
  return n;
}

function finiteDomain(data) {
  if (!Number.isFinite(data.yMin) || !Number.isFinite(data.yMax) || data.yMax <= data.yMin) return false;
  const s = M.makeScales(SVG_W, data.yMin, data.yMax);
  return M.activeLinesOf(data).every((l) => !M.polylinePoints(l, s).includes('NaN'));
}

function v7w() {
  const ws4 = M.windowStartOf(TODAY, 4); // 2026-08-07
  const start = '2026-01-01';
  const yesterday = M.windowStartOf(TODAY, 1);

  // a. One round in the window.
  {
    const scores = [sc('p0', 10, '2026-05-01'), sc('p1', 30, '2026-05-01'), sc('p2', 50, '2026-05-01'),
      sc('p0', 10, '2026-06-01'), sc('p1', 5, '2026-06-01'), sc('p2', -5, '2026-06-01'),
      sc('p0', 4, yesterday), sc('p1', -3, yesterday), sc('p2', 2, yesterday)];
    const season = M.buildChartData(scores, people(3), start, TODAY);
    const w = M.windowChartData(season, start, ws4, TODAY);
    const lines = M.activeLinesOf(w);
    const s = M.makeScales(SVG_W, w.yMin, w.yMax);
    const rows = M.buildTooltipRows(lines, M.makeToX(ws4, TODAY)(yesterday), [], M.PAD_T + 130, s);
    if (w.dates.length === 1 && lines.every((l) => l.points.length === 3) && rows.length === 3 && finiteDomain(w)) {
      ok('V7w one-round', 'entry + vertex + hold on every line, 1 snap date, tooltip has rows');
    } else {
      bad('V7w one-round', `dates=${w.dates.length} pts=${lines.map((l) => l.points.length)} rows=${rows.length}`);
    }
  }

  // b. Every line flat: the window's only rounds scored 0. Enabled (score rows
  //    exist), and the players who played at 0 still define the axis.
  {
    const scores = [sc('p0', 5, '2026-05-01'), sc('p1', 5, '2026-05-01'), sc('p0', 0, yesterday), sc('p1', 0, yesterday)];
    const season = M.buildChartData(scores, people(2), start, TODAY);
    const enabled = M.rangeHasRounds(season.dates, ws4, TODAY);
    const w = M.windowChartData(season, start, ws4, TODAY);
    const allFlat = M.activeLinesOf(w).every((l) => new Set(l.points.map((p) => p.y)).size === 1);
    if (enabled && allFlat && w.yMin === -5 && w.yMax === 15 && finiteDomain(w)) {
      ok('V7w all-flat', 'enabled on zero-point rounds; domain [-5, 15] around the flat value, no NaN');
    } else {
      bad('V7w all-flat', `enabled=${enabled} allFlat=${allFlat} domain [${w.yMin}, ${w.yMax}]`);
    }
  }

  // c. Source set empty but the range enabled — unreachable through buildChartData,
  //    so hand-built. Must fall back to all plotted lines, not ±Infinity.
  {
    const hand = {
      dates: [yesterday],
      yMin: -99,
      yMax: 99,
      lines: [
        { id: 'a', name: 'A', thin: false, playedDates: ['2026-05-01'], points: [{ x: 0, y: 0, date: start }, { x: 0.5, y: 40, date: '2026-05-01' }] },
        { id: 'b', name: 'B', thin: false, playedDates: ['2026-05-01'], points: [{ x: 0, y: 0, date: start }, { x: 0.5, y: -20, date: '2026-05-01' }] },
      ],
    };
    const w = M.windowChartData(hand, start, ws4, TODAY);
    const none = M.windowChartData({ dates: [yesterday], yMin: 0, yMax: 0, lines: [] }, start, ws4, TODAY);
    if (finiteDomain(w) && w.yMin <= -20 && w.yMax >= 40 && none.yMin === -10 && none.yMax === 10) {
      ok('V7w empty-source', `falls back to all lines [${w.yMin}, ${w.yMax}]; no lines at all -> [-10, 10]`);
    } else {
      bad('V7w empty-source', `domain [${w.yMin}, ${w.yMax}], no-lines [${none.yMin}, ${none.yMax}]`);
    }
  }

  // d. Played but scored 0. Synthetic, with an arm showing a vertex-based source
  //    would have parked them; then the real case in the fixture.
  {
    const scores = [sc('p0', 500, '2026-05-01'), sc('p1', 10, '2026-05-01'), sc('p0', 0, yesterday), sc('p1', 8, yesterday)];
    const season = M.buildChartData(scores, people(2), start, TODAY);
    const w = M.windowChartData(season, start, ws4, TODAY);
    const p0 = w.lines.find((l) => l.id === 'p0');
    const inside = p0.points.every((p) => p.y >= w.yMin && p.y <= w.yMax);
    const vertexHi = Math.max(...w.lines.find((l) => l.id === 'p1').points.map((p) => p.y));
    const vertexBasedWouldPark = 500 > vertexHi + Math.max(10, Math.round(vertexHi * 0.1));
    if (inside && vertexBasedWouldPark) ok('V7w played-zero', 'a 0-point round keeps the player on-axis; a vertex-based source would have parked them');
    else bad('V7w played-zero', `inside=${inside} vertexBasedWouldPark=${vertexBasedWouldPark}`);

    let realCases = 0;
    let realBad = 0;
    for (const c of [windowCase('ycwindex', 'd10'), windowCase('windexcup', 'd10'), windowCase('windexcup', 'd4')]) {
      if (!c.enabled) continue;
      for (const l of M.activeLinesOf(c.data)) {
        const played = l.playedDates.some(c.inWindow);
        // Ask the SEASON line. The windowed line's hold vertex is dated today, which
        // is inside the window, so it would pass for a round vertex on every line.
        const seasonLine = c.season.lines.find((x) => x.id === l.id);
        const hasVertex = seasonLine.points.slice(1).some((p) => c.inWindow(p.date));
        if (played && !hasVertex) {
          realCases++;
          if (l.points.some((p) => p.y < c.data.yMin || p.y > c.data.yMax)) realBad++;
        }
      }
    }
    if (realCases > 0 && realBad === 0) ok('V7w played-zero fixture', `${realCases} real played-but-no-vertex lines, all on-axis`);
    else bad('V7w played-zero fixture', `${realCases} real cases, ${realBad} parked`);
  }

  // e. Window opens before the season does.
  {
    const seasonStart = M.windowStartOf(TODAY, 2);
    const scores = [sc('p0', 6, yesterday), sc('p1', -4, yesterday)];
    const season = M.buildChartData(scores, people(2), seasonStart, TODAY);
    const ws10 = M.windowStartOf(TODAY, 10);
    const w = M.windowChartData(season, seasonStart, ws10, TODAY);
    const lines = M.activeLinesOf(w);
    const entriesZero = lines.every((l) => l.points[0].x === 0 && l.points[0].y === 0);
    const noSeasonStartVertex = lines.every((l) => !l.points.some((p) => p.date === seasonStart));
    if (entriesZero && noSeasonStartVertex && strokes(lines) === 0) ok('V7w before-season', 'entry 0, season-start vertex skipped, no strokes');
    else bad('V7w before-season', `entriesZero=${entriesZero} noSeasonStartVertex=${noSeasonStartVertex} strokes=${strokes(lines)}`);
  }

  // f. A vertex exactly on windowStart becomes the entry value, not a snap date.
  {
    const scores = [sc('p0', 3, '2026-05-01'), sc('p0', 7, ws4), sc('p0', 2, yesterday)];
    const season = M.buildChartData(scores, people(1), start, TODAY);
    const w = M.windowChartData(season, start, ws4, TODAY);
    const l = w.lines[0];
    if (l.points[0].y === 10 && !w.dates.includes(ws4) && l.points.filter((p) => p.x === 0).length === 1) {
      ok('V7w edge-vertex', `entry = ${l.points[0].y}, the standing after ${ws4}; not a snap date`);
    } else {
      bad('V7w edge-vertex', `entry ${l.points[0].y} dates ${w.dates} zeros ${l.points.filter((p) => p.x === 0).length}`);
    }
  }

  // g. A thin player whose only vertex falls inside the window.
  {
    const scores = [
      sc('p0', 40, yesterday),
      sc('p1', 10, '2026-03-01'), sc('p1', 10, '2026-05-01'), sc('p1', 10, yesterday),
      sc('p2', 20, '2026-03-01'), sc('p2', 15, '2026-05-01'), sc('p2', -5, yesterday),
    ];
    const season = M.buildChartData(scores, people(3), start, TODAY);
    const w = M.windowChartData(season, start, ws4, TODAY);
    const lines = M.activeLinesOf(w);
    const p0 = lines.find((l) => l.id === 'p0');
    const toX = M.makeToX(ws4, TODAY);
    const nx = toX(yesterday);
    const s = M.makeScales(SVG_W, w.yMin, w.yMax);
    const auto = M.buildTooltipRows(lines, nx, [], s.plotY(p0.points[0].y), s);
    const sel = M.buildTooltipRows(lines, nx, ['p0'], M.PAD_T, s);
    const expectedEntry = M.valueAt(season.lines[0].points, M.makeToX(start, TODAY)(ws4));
    if (p0 && p0.thin && p0.points[0].y === expectedEntry && expectedEntry > 0 && !auto.some((r) => r.id === 'p0') && sel.some((r) => r.id === 'p0')) {
      ok('V7w thin-in-window', `drawn, entry ${expectedEntry.toFixed(2)} on its season diagonal, out of nearest-5, selectable`);
    } else {
      bad('V7w thin-in-window', `thin=${p0 && p0.thin} entry=${p0 && p0.points[0].y} want ${expectedEntry} auto=${auto.map((r) => r.id)} sel=${sel.map((r) => r.id)}`);
    }
  }

  // h. A round today: vertex at x=1 and no hold vertex on top of it.
  {
    const scores = [sc('p0', 5, '2026-05-01'), sc('p0', 3, TODAY)];
    const season = M.buildChartData(scores, people(1), start, TODAY);
    const l = M.windowChartData(season, start, ws4, TODAY).lines[0];
    const atOne = l.points.filter((p) => p.x === 1);
    if (atOne.length === 1 && atOne[0].date === TODAY && atOne[0].y === 8) ok('V7w round-today', 'one vertex at x=1, the round itself');
    else bad('V7w round-today', `x=1 points ${JSON.stringify(atOne)}`);
  }

  // i. Zero-round windows disable, both sides of the predicate; a completed season
  //    (anchored to today) disables both windows.
  {
    const yc4 = windowCase('ycwindex', 'd4');
    const wc4 = windowCase('windexcup', 'd4');
    const done = M.buildChartData([sc('p0', 5, '2026-03-01'), sc('p0', 5, '2026-06-30')], people(1), start, TODAY);
    const doneEnabled = WINDOWS.some((rk) => M.rangeHasRounds(done.dates, M.windowStartOf(TODAY, M.RANGE_DAYS[rk]), TODAY));
    if (!yc4.enabled && wc4.enabled && !doneEnabled) ok('V7w zero-round', 'ycwindex 4d disabled, windexcup 4d enabled, completed season disables both');
    else bad('V7w zero-round', `yc4=${yc4.enabled} wc4=${wc4.enabled} completed=${doneEnabled}`);
  }

  // Regression arms from Phase A.
  const windows = enabledWindows('V7w');
  const strokeCount = windows.reduce((n, c) => n + strokes(M.activeLinesOf(c.data)), 0);
  const naive = windows.reduce((n, c) => {
    const naiveLines = M.activeLinesOf(c.season).map((l) => ({ ...l, points: l.points.map((p) => ({ ...p, x: c.toX(p.date) })) }));
    return n + strokes(naiveLines);
  }, 0);
  if (strokeCount === 0 && naive > 0) ok('V7w no-strokes', `0 vertical strokes; swapping toX over Season points would draw ${naive}`);
  else bad('V7w no-strokes', `windowed strokes ${strokeCount}, naive ${naive} (want 0 and > 0)`);

  let leaked = 0;
  let naiveLeaks = 0;
  for (const c of windows) {
    leaked += c.data.dates.filter((d) => !c.inWindow(d)).length;
    const s = M.makeScales(SVG_W, c.data.yMin, c.data.yMax);
    const snapped = M.nearestDate(c.season.dates, c.toX, s, M.PAD_L);
    if (snapped !== null && !c.inWindow(snapped)) naiveLeaks++;
  }
  if (leaked === 0 && naiveLeaks > 0) ok('V7w snap-filter', `every snap date inside its window; unfiltered, ${naiveLeaks} windows snap to a date outside at the left edge`);
  else bad('V7w snap-filter', `leaked ${leaked}, unfiltered leaks ${naiveLeaks} (want 0 and > 0)`);
}

/* ── V9 ── Tooltip row order matches visual line order ─────────────────────── */
function v9(key) {
  const { data, seasonStart } = load(key);
  const toX = M.makeToX(seasonStart, TODAY);
  const s = M.makeScales(SVG_W, data.yMin, data.yMax);
  const lines = M.activeLinesOf(data);
  const ids = lines.map((l) => l.id);

  let checked = 0;
  let violations = 0;
  let maxRows = 0;

  const cursors = [M.PAD_T + 20, M.PAD_T + 130, M.PAD_T + 240];
  const selections = [[], ids.slice(0, 2), ids.slice(0, M.MAX_SELECTED)];

  for (const sel of selections) {
    for (const cy of cursors) {
      for (const d of data.dates) {
        const rows = M.buildTooltipRows(lines, toX(d), sel, cy, s);
        maxRows = Math.max(maxRows, rows.length);
        const positioned = rows.filter((r) => r.svgY !== null);
        for (let i = 1; i < positioned.length; i++) {
          if (positioned[i].svgY < positioned[i - 1].svgY) violations++;
        }
        // Every positioned row's svgY must be the pixel the line actually sits at.
        for (const row of positioned) {
          const line = lines.find((l) => l.id === row.id);
          const expected = s.toSvgY(M.valueAt(line.points, toX(d)));
          if (Math.abs(expected - row.svgY) > 1e-9) violations++;
        }
        // Ended rows sort last.
        const firstEnded = rows.findIndex((r) => r.ended);
        if (firstEnded !== -1 && rows.slice(firstEnded).some((r) => !r.ended)) violations++;
        checked++;
      }
    }
  }

  if (violations === 0) ok('V9 ' + key, `${checked} tooltip states, row order == svgY ascending, max ${maxRows} rows`);
  else bad('V9 ' + key, `${violations} ordering violations over ${checked} states`);

  if (maxRows <= M.MAX_TOOLTIP_ROWS) ok('V9 row cap ' + key, `never exceeded ${M.MAX_TOOLTIP_ROWS} rows`);
  else bad('V9 row cap ' + key, `saw ${maxRows} rows`);
}

/* ── V9w ── Tooltip row order per window; no ended rows ────────────────────── */
function v9w() {
  for (const c of enabledWindows('V9w')) {
    const s = M.makeScales(SVG_W, c.data.yMin, c.data.yMax);
    const lines = M.activeLinesOf(c.data);
    const ids = lines.map((l) => l.id);
    const clampedIds = lines.filter((l) => l.points.some((p) => p.y < c.data.yMin || p.y > c.data.yMax)).map((l) => l.id);
    const selections = [[], ids.slice(0, 2), ids.slice(0, M.MAX_SELECTED)];
    if (clampedIds.length) selections.push(clampedIds.slice(0, M.MAX_SELECTED));
    const cursors = [M.PAD_T + 20, M.PAD_T + 130, M.PAD_T + 240];

    let checked = 0;
    let order = 0;
    let pixel = 0;
    let ended = 0;
    let maxRows = 0;
    for (const sel of selections) {
      for (const cy of cursors) {
        for (const d of c.data.dates) {
          const nx = c.toX(d);
          const rows = M.buildTooltipRows(lines, nx, sel, cy, s);
          maxRows = Math.max(maxRows, rows.length);
          if (rows.some((r) => r.ended)) ended++;
          for (let i = 1; i < rows.length; i++) {
            const a = rows[i - 1];
            const b = rows[i];
            if (b.svgY < a.svgY - 1e-9 || (Math.abs(b.svgY - a.svgY) <= 1e-9 && b.value > a.value)) order++;
          }
          for (const row of rows) {
            const line = lines.find((l) => l.id === row.id);
            if (Math.abs(s.plotY(M.valueAt(line.points, nx)) - row.svgY) > 1e-9) pixel++;
          }
          checked++;
        }
      }
    }
    const name = `V9w ${c.key} ${c.rk}`;
    if (order + pixel + ended === 0 && maxRows <= M.MAX_TOOLTIP_ROWS) {
      ok(name, `${checked} states: order svgY then value, dots on plotY, no ended rows, max ${maxRows} rows`);
    } else {
      bad(name, `order ${order}, pixel ${pixel}, ended-row states ${ended}, max rows ${maxRows}`);
    }
  }

  // Tie-break coverage. The fixture never parks two players on the same edge, so
  // force it: three players far below the window, all selected.
  const scores = [
    sc('p0', -300, '2026-05-01'), sc('p1', -250, '2026-05-01'), sc('p2', -280, '2026-05-01'),
    sc('p3', 10, '2026-05-01'), sc('p3', 5, M.windowStartOf(TODAY, 1)),
    sc('p4', 20, '2026-05-01'), sc('p4', -5, M.windowStartOf(TODAY, 1)),
  ];
  const season = M.buildChartData(scores, people(5), '2026-01-01', TODAY);
  const ws = M.windowStartOf(TODAY, 4);
  const w = M.windowChartData(season, '2026-01-01', ws, TODAY);
  const s = M.makeScales(SVG_W, w.yMin, w.yMax);
  const rows = M.buildTooltipRows(M.activeLinesOf(w), M.makeToX(ws, TODAY)(M.windowStartOf(TODAY, 1)), ['p0', 'p1', 'p2'], M.PAD_T, s);
  const floor = M.PAD_T + s.plotH;
  const order = rows.map((r) => r.id).join(',');
  if (rows.length === 3 && rows.every((r) => r.svgY === floor) && order === 'p1,p2,p0') {
    ok('V9w floor tie-break', 'three players parked on the floor list by true value, highest first (p1 -250, p2 -280, p0 -300)');
  } else {
    bad('V9w floor tie-break', `rows ${order} svgY ${rows.map((r) => r.svgY)} (floor ${floor})`);
  }
}

/* ── V13 ── The same moment reads the same value in Season and in a window ─────
 * What Q3 (true crop) buys. Every pixel column of the window is mapped through
 * epoch ms to Season's nx, and the two lines must agree wherever Season has a value.
 */
function v13() {
  for (const c of enabledWindows('V13')) {
    const s = M.makeScales(SVG_W, c.data.yMin, c.data.yMax);
    const seasonLines = M.activeLinesOf(c.season);
    const winLines = M.activeLinesOf(c.data);
    const wMs = M.dayMs(c.ws);
    const tMs = M.dayMs(TODAY);
    const ssMs = M.dayMs(c.seasonStart);

    // The rejected entry rule: the step value at the window start (last Season
    // vertex on or before it), everything else identical.
    const rejected = seasonLines.map((l) => {
      let entry = 0;
      for (const p of l.points) if (p.date <= c.ws) entry = p.y;
      const pts = [{ x: 0, y: entry }];
      for (const p of l.points.slice(1)) if (c.inWindow(p.date)) pts.push({ x: c.toX(p.date), y: p.y });
      if (pts[pts.length - 1].x < 1) pts.push({ x: 1, y: pts[pts.length - 1].y });
      return pts;
    });

    let compared = 0;
    let differ = 0;
    let seasonEnded = 0;
    let rejectedDiffer = 0;
    for (let px = 0; px <= s.plotW; px++) {
      const nx = px / s.plotW;
      const snx = Math.max(0, (wMs + nx * (tMs - wMs) - ssMs) / (tMs - ssMs));
      for (let i = 0; i < seasonLines.length; i++) {
        if (seasonLines[i].id !== winLines[i].id) {
          bad(`V13 ${c.key} ${c.rk}`, 'line order differs between Season and window');
          return;
        }
        const a = M.valueAt(seasonLines[i].points, snx);
        const b = M.valueAt(winLines[i].points, nx);
        if (a === null) {
          if (b !== null) seasonEnded++;
          continue;
        }
        compared++;
        if (b === null || Math.abs(a - b) > 1e-9) differ++;
        if (Math.abs(M.valueAt(rejected[i], nx) - a) > 1e-6) rejectedDiffer++;
      }
    }
    const name = `V13 ${c.key} ${c.rk}`;
    if (compared > 0 && differ === 0) ok(name, `${compared} column comparisons, Season and window agree; ${seasonEnded} where Season has ended and the window holds (expected, Q2)`);
    else bad(name, `${differ} of ${compared} comparisons disagree`);
    if (rejectedDiffer > 0) ok(name + ' falsifier', `step-value entry disagrees with Season at ${rejectedDiffer} (test discriminates)`);
    else bad(name + ' falsifier', 'step-value entry agreed everywhere — V13 cannot tell a crop from the rejected rule');
  }
}

/* ── V-pills ── Players, order, hues and thinness hold across ranges ────────── */
function vPills() {
  for (const key of FIXTURES) {
    const season = load(key).data;
    const ids = M.activeLinesOf(season).map((l) => l.id);
    const thin = M.activeLinesOf(season).map((l) => l.thin).join();
    const selections = [[ids[0]], ids.slice(0, 2), ids.slice(0, M.MAX_SELECTED), [ids[ids.length - 1], ids[1]]];
    const huesOf = (sel) => JSON.stringify([...M.assignHues(ids, sel)].sort());
    const problems = [];
    let ranges = 0;
    for (const rk of WINDOWS) {
      const c = windowCase(key, rk);
      if (!c.enabled) continue;
      ranges++;
      const wl = M.activeLinesOf(c.data);
      if (wl.map((l) => l.id).join() !== ids.join()) problems.push(`${rk} ids/order differ`);
      if (wl.map((l) => l.thin).join() !== thin) problems.push(`${rk} thin flags differ`);
      for (const sel of selections) {
        if (huesOf(sel) !== JSON.stringify([...M.assignHues(wl.map((l) => l.id), sel)].sort())) problems.push(`${rk} hues differ for ${sel}`);
      }
    }
    if (ranges === 0) bad(`V-pills ${key}`, 'no enabled window to compare against');
    else if (problems.length === 0) ok(`V-pills ${key}`, `${ids.length} players: same ids, order, hues and thin flags in Season and ${ranges} window(s)`);
    else bad(`V-pills ${key}`, problems.join('; '));
  }
}

/* ── V-clamp ── Clamping is exact: only wholly horizontal lines leave the domain */
function clampViolations(lines, data, inWindow) {
  const out = [];
  for (const l of lines) {
    const outside = l.points.some((p) => p.y < data.yMin || p.y > data.yMax);
    if (outside && new Set(l.points.map((p) => p.y)).size !== 1) out.push(`${l.id} leaves the domain but is not horizontal`);
    if (l.playedDates.some(inWindow) && outside) out.push(`${l.id} played in the window but leaves the domain`);
  }
  return out;
}

function vClamp() {
  let clamped = 0;
  for (const c of enabledWindows('V-clamp')) {
    const lines = M.activeLinesOf(c.data);
    clamped += lines.filter((l) => l.points.some((p) => p.y < c.data.yMin || p.y > c.data.yMax)).length;
    const v = clampViolations(lines, c.data, c.inWindow);
    if (v.length === 0) ok(`V-clamp ${c.key} ${c.rk}`, 'every line outside the domain is wholly horizontal; every player who played is inside');
    else bad(`V-clamp ${c.key} ${c.rk}`, v.join('; '));
  }
  // Arm: a line that CROSSES the boundary must be flagged, or this check cannot fail.
  const crossing = { id: 'x', playedDates: [], points: [{ x: 0, y: 0 }, { x: 1, y: 1000 }] };
  const armed = clampViolations([crossing], { yMin: -10, yMax: 10 }, () => false).length > 0;
  if (armed && clamped > 0) ok('V-clamp arm', `a boundary-crossing line is flagged; ${clamped} real clamped lines checked`);
  else bad('V-clamp arm', `crossing flagged=${armed}, real clamped lines=${clamped}`);
}

/* ── V12 ── Season output byte-identical to BASELINE_COMMIT ───────────────── */
function seasonSnapshot(Mod, key) {
  const f = fixture[key];
  const data = Mod.buildChartData(f.scores, f.standings, f.seasonStart, TODAY);
  const toX = Mod.makeToX(f.seasonStart, TODAY);
  const s = Mod.makeScales(SVG_W, data.yMin, data.yMax);
  const lines = Mod.activeLinesOf(data);
  const ids = lines.map((l) => l.id);
  const cursors = [Mod.PAD_T + 20, Mod.PAD_T + 130, Mod.PAD_T + 240];
  const snap = {
    yMin: data.yMin,
    yMax: data.yMax,
    dates: data.dates,
    points: lines.map((l) => ({ id: l.id, name: l.name, points: l.points })),
    strings: lines.map((l) => Mod.polylinePoints(l, s)),
    ticks: Mod.buildMonthTicks(f.seasonStart, TODAY, toX).map((t) => ({ nx: t.nx, label: t.label })),
    rows: [],
    candidates: [],
    hues: [],
    snaps: [],
  };
  for (const sel of [[], ids.slice(0, 2), ids.slice(0, Mod.MAX_SELECTED)]) {
    snap.hues.push([...Mod.assignHues(ids, sel)]);
    for (const cy of cursors) for (const d of data.dates) snap.rows.push(Mod.buildTooltipRows(lines, toX(d), sel, cy, s));
  }
  for (const l of lines) for (const d of data.dates) snap.candidates.push(Mod.isNearestCandidate(l, toX(d)));
  for (let px = Mod.PAD_L; px <= SVG_W - Mod.PAD_R; px += 7) snap.snaps.push(Mod.nearestDate(data.dates, toX, s, px));
  return JSON.stringify(snap);
}

function v12() {
  const dir = path.join(BUILD, 'baseline');
  const srcDir = path.join(BUILD, 'baseline-src');
  fs.mkdirSync(srcDir, { recursive: true });
  const srcFile = path.join(srcDir, 'historyChartMath.ts');
  fs.writeFileSync(srcFile, gitShow('windex-expo/lib/historyChartMath.ts'));
  const B = compile(srcFile, dir);

  if (typeof M.windowChartData === 'function' && typeof B.windowChartData === 'undefined') {
    ok('V12 arm', `baseline is ${BASELINE_COMMIT} (no windowChartData), not the working module compared with itself`);
  } else {
    bad('V12 arm', `baseline exports windowChartData: ${typeof B.windowChartData} — comparing a module with itself`);
    return;
  }
  for (const key of FIXTURES) {
    const a = seasonSnapshot(B, key);
    const b = seasonSnapshot(M, key);
    if (a === b) ok(`V12 ${key}`, `Season byte-identical to ${BASELINE_COMMIT}: domain, points, polyline strings, ticks, tooltip rows, candidates, hues, snaps (${b.length} chars)`);
    else {
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      bad(`V12 ${key}`, `Season output differs from ${BASELINE_COMMIT} at char ${i}: …${a.slice(Math.max(0, i - 40), i + 40)}… vs …${b.slice(Math.max(0, i - 40), i + 40)}…`);
    }
  }
}

/* ── V14 ── Standings toggle styles identical to BASELINE_COMMIT (static) ──────
 * The live half — computed styles captured before and after deploy — is run by
 * hand at G4. This half needs no build and no session: it parses the pre-extraction
 * standings.tsx out of git and compares the style literals and the composition of
 * every style array against SegmentedToggle.tsx.
 */
const TOGGLE_KEYS = ['toggleWrap', 'togglePill', 'togglePillActive', 'togglePillDisabled', 'toggleText', 'toggleTextActive', 'toggleTextDisabled'];

function parseToggle(ts, text, fileName) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const consts = {};
  const styleInits = {};
  const arrays = [];
  let wrap = false;

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteral(node.initializer)) {
      consts[node.name.text] = node.initializer.text;
    }
    if (ts.isCallExpression(node) && node.expression.getText(sf) === 'StyleSheet.create' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
      for (const prop of node.arguments[0].properties) {
        if (ts.isPropertyAssignment(prop) && TOGGLE_KEYS.includes(prop.name.getText(sf))) styleInits[prop.name.getText(sf)] = prop.initializer;
      }
    }
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === 'style' && node.initializer && ts.isJsxExpression(node.initializer)) {
      const e = node.initializer.expression;
      if (e && ts.isPropertyAccessExpression(e) && e.getText(sf) === 'styles.toggleWrap') wrap = true;
      if (e && ts.isArrayLiteralExpression(e)) {
        const names = e.elements.map((el) => {
          const target = ts.isBinaryExpression(el) ? el.right : el;
          return ts.isPropertyAccessExpression(target) ? target.name.getText(sf) : '?';
        });
        if (names.some((n) => n.startsWith('toggle'))) arrays.push(names);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const evaluate = (n) => {
    if (ts.isStringLiteral(n)) return n.text;
    if (ts.isNumericLiteral(n)) return Number(n.text);
    if (ts.isIdentifier(n)) {
      if (!(n.text in consts)) throw new Error(`unresolved identifier ${n.text} in ${fileName}`);
      return consts[n.text];
    }
    if (ts.isObjectLiteralExpression(n)) {
      return Object.fromEntries(n.properties.map((p) => [p.name.getText(sf), evaluate(p.initializer)]));
    }
    throw new Error(`unsupported style value ${n.getText(sf)} in ${fileName}`);
  };
  const styles = Object.fromEntries(TOGGLE_KEYS.map((k) => [k, styleInits[k] ? evaluate(styleInits[k]) : undefined]));
  return { styles, arrays, wrap };
}

/** Every baseline array must be the component's array for that element with only
 *  trailing entries missing — same head, same relative order. */
function arraysMatch(baseArrays, compArrays) {
  const problems = [];
  const PILL = ['togglePill', 'togglePillActive', 'togglePillDisabled'];
  const TEXT = ['toggleText', 'toggleTextActive', 'toggleTextDisabled'];
  const comp = (head) => compArrays.find((a) => a[0] === head);
  for (const [head, want] of [['togglePill', PILL], ['toggleText', TEXT]]) {
    const c = comp(head);
    if (!c || c.join() !== want.join()) problems.push(`component ${head} array is ${c ? c.join(',') : 'missing'}, want ${want.join(',')} (active BEFORE disabled)`);
  }
  for (const b of baseArrays) {
    const c = comp(b[0]);
    if (!c || b.some((name, i) => c[i] !== name)) problems.push(`baseline array ${b.join(',')} is not a prefix of ${c ? c.join(',') : 'nothing'}`);
  }
  return problems;
}

function v14() {
  const ts = require(path.join(EXPO, 'node_modules', 'typescript'));
  const base = parseToggle(ts, gitShow('windex-expo/app/(tabs)/standings.tsx'), 'standings@baseline.tsx');
  const compText = fs.readFileSync(TOGGLE, 'utf8');
  const comp = parseToggle(ts, compText, 'SegmentedToggle.tsx');

  const missing = TOGGLE_KEYS.filter((k) => base.styles[k] === undefined);
  if (missing.length) {
    bad('V14 baseline', `could not read ${missing.join(', ')} from ${BASELINE_COMMIT} — nothing was compared`);
    return;
  }
  const diffs = TOGGLE_KEYS.filter((k) => JSON.stringify(base.styles[k]) !== JSON.stringify(comp.styles[k]));
  if (diffs.length === 0) ok('V14 styles', `7 toggle styles deep-equal to standings.tsx@${BASELINE_COMMIT}, OLIVE resolved`);
  else bad('V14 styles', diffs.map((k) => `${k}: ${JSON.stringify(base.styles[k])} -> ${JSON.stringify(comp.styles[k])}`).join('; '));

  const arrayProblems = arraysMatch(base.arrays, comp.arrays);
  if (base.arrays.length === 4 && arrayProblems.length === 0 && comp.wrap) {
    ok('V14 composition', `all ${base.arrays.length} baseline style arrays reproduced in order, active before disabled; wrap uses toggleWrap`);
  } else {
    bad('V14 composition', `${base.arrays.length} baseline arrays (want 4); wrap=${comp.wrap}; ${arrayProblems.join('; ')}`);
  }

  const standingsNow = fs.readFileSync(STANDINGS, 'utf8');
  if (!/toggle(Wrap|Pill|Text)/.test(standingsNow) && standingsNow.includes('<SegmentedToggle')) {
    ok('V14 single copy', 'standings.tsx renders SegmentedToggle and no longer carries its own toggle styles');
  } else {
    bad('V14 single copy', 'standings.tsx still holds toggle styles or does not use SegmentedToggle — two copies will drift');
  }

  // Arms: a changed value and a "fixed" (reordered) array must both be caught.
  const nudged = parseToggle(ts, compText.replace('paddingVertical: 7', 'paddingVertical: 8'), 'nudged.tsx');
  const reordered = parseToggle(
    ts,
    compText.replace(
      'active && styles.togglePillActive, option.disabled && styles.togglePillDisabled',
      'option.disabled && styles.togglePillDisabled, active && styles.togglePillActive',
    ),
    'reordered.tsx',
  );
  const nudgeCaught = JSON.stringify(nudged.styles.togglePill) !== JSON.stringify(base.styles.togglePill);
  const reorderCaught = arraysMatch(base.arrays, reordered.arrays).length > 0;
  if (nudgeCaught && reorderCaught && compText.includes('active && styles.togglePillActive, option.disabled && styles.togglePillDisabled')) {
    ok('V14 arms', 'a 1px style change is caught; reordering disabled before active (the tempting "fix") is caught');
  } else {
    bad('V14 arms', `nudge caught=${nudgeCaught}, reorder caught=${reorderCaught} — the check could pass a drifted toggle`);
  }
}

/* ── Hue assignment (supports §1's claims) ─────────────────────────────────── */
function vHues(key) {
  const { data } = load(key);
  const ids = M.activeLinesOf(data).map((l) => l.id);

  const a = M.assignHues(ids, [ids[0], ids[3]]);
  const b = M.assignHues(ids, [ids[3], ids[0]]);
  const orderIndependent = a.get(ids[0]) === b.get(ids[0]) && a.get(ids[3]) === b.get(ids[3]);

  const four = M.assignHues(ids, ids.slice(0, M.MAX_SELECTED));
  const distinct = new Set(four.values()).size === Math.min(M.MAX_SELECTED, ids.length);

  // Rank-independence: the same player must get the same hue when standings
  // order is reversed, because preference is keyed on player_id, not position.
  const rev = M.assignHues([...ids].reverse(), [ids[0]]);
  const rankStable = rev.get(ids[0]) === M.assignHues(ids, [ids[0]]).get(ids[0]);

  if (orderIndependent && distinct && rankStable) {
    ok('Hues ' + key, 'click-order independent, collision-free at cap, rank-stable');
  } else {
    bad('Hues ' + key, `orderIndep=${orderIndependent} distinct=${distinct} rankStable=${rankStable}`);
  }
}

/* ── All time ─────────────────────────────────────────────────────────────────
 * Fixture: fixture.alltime (see the header). Every case is built the way the
 * component builds it: the players are the current standings, and the season on screen
 * is found by start date, not through careerSpans.
 */
function careerCase(key, seasonId, today = TODAY) {
  const f = fixture[key];
  const a = fixture.alltime[key];
  const season = M.buildChartData(f.scores, f.standings, f.seasonStart, TODAY);
  const players = f.standings;
  const spans = M.careerSpans(a.seasons, today);
  const onScreen = seasonId ?? a.seasons.find((s) => s.start_date === f.seasonStart).id;
  return {
    key,
    f,
    a,
    seasonId: onScreen,
    season,
    players,
    spans,
    enabled: M.careerEnabled(spans, a.rows, players.map((p) => p.player_id), onScreen),
    data: M.buildCareerData(a.rows, spans, players),
    toX: M.careerToX(spans),
  };
}

const seasonsOf = (...ranges) => ranges.map(([id, start_date, end_date]) => ({ id, start_date, end_date }));
const crow = (season_id, player_id, total_points, rounds_played = 1) => ({ season_id, player_id, rounds_played, total_points });

/* ── V-order ── Seasons in start_date order, never id order ─────────────────── */
function vOrder() {
  for (const key of FIXTURES) {
    const a = fixture.alltime[key];
    const spans = M.careerSpans(a.seasons, TODAY);
    const ids = spans.map((s) => s.id).join();
    const starts = spans.map((s) => s.start);
    const ascending = starts.every((d, i) => i === 0 || starts[i - 1] < d);
    const fromReversed = M.careerSpans([...a.seasons].reverse(), TODAY).map((s) => s.id).join();
    if (spans.length > 0 && ascending && fromReversed === ids) {
      ok(`V-order ${key}`, `${spans.length} season(s) in start_date order (${starts.join(', ')}); reversed input gives the same`);
    } else {
      bad(`V-order ${key}`, `order ${ids}, starts ${starts.join(', ')}, from reversed input ${fromReversed}`);
    }
  }

  // Falsifier. The fixture's season ids do not sort in date order, so id order is a
  // different sequence, and a career built in it is a plausible chart that is wrong.
  // If either failed to differ, V-order could not catch the mistake it exists for.
  const c = careerCase('windexcup');
  const byId = [...c.spans].sort((x, y) => x.id.localeCompare(y.id));
  const ys = (data) => data.lines.map((l) => l.points.map((p) => p.y).join('/'));
  const right = ys(c.data);
  const wrong = ys(M.buildCareerData(c.a.rows, byId, c.players));
  const changed = right.filter((seq, i) => seq !== wrong[i]).length;
  const idSeq = byId.map((s) => s.id).join(' ');
  const startSeq = c.spans.map((s) => s.id).join(' ');
  if (idSeq !== startSeq && changed > 0) {
    ok('V-order falsifier', `id order ${idSeq} vs start order ${startSeq}; built in id order, ${changed} of ${right.length} career lines change`);
  } else {
    bad('V-order falsifier', `id order ${idSeq}, start order ${startSeq}, ${changed} lines change — cannot tell the two apart`);
  }
}

/* ── V1c ── Career interpolation matches the rendered pixel, every column ───── */
function v1c() {
  const c = careerCase('windexcup');
  const s = M.makeScales(SVG_W, c.data.yMin, c.data.yMax);
  let compared = 0;
  let worst = 0;
  let carryDis = 0;
  let vertexWorst = 0;
  let vertices = 0;
  for (const line of M.activeLinesOf(c.data)) {
    const str = M.polylinePoints(line, s);
    for (let px = 0; px <= s.plotW; px++) {
      const nx = px / s.plotW;
      const v = M.valueAt(line.points, nx);
      const B = pixelSpaceLookup(str, s.toSvgX(nx));
      // Right of today's vertex is the season still to play: no line, on both paths.
      if (v === null || B === null) {
        if ((v === null) !== (B === null)) worst = Infinity;
        continue;
      }
      worst = Math.max(worst, Math.abs(s.plotY(v) - B));
      compared++;
      const cf = carryForward(line.points, nx);
      if (cf !== null && Math.abs(s.plotY(cf) - B) > 0.5) carryDis++;
    }
    // At a snap date the tooltip reads the season's vertex itself, exactly.
    for (const d of c.data.dates) {
      const p = line.points.find((q) => q.date === d);
      if (!p) continue;
      vertexWorst = Math.max(vertexWorst, Math.abs(M.valueAt(line.points, c.toX(d)) - p.y));
      vertices++;
    }
  }
  if (compared > 0 && worst < 0.5 && vertices > 0 && vertexWorst < 1e-9) {
    ok('V1c windexcup', `${compared} column comparisons, worst |A-B| = ${worst.toFixed(6)}px; ${vertices} vertices read back exactly at their snap dates`);
  } else {
    bad('V1c windexcup', `worst |A-B| = ${worst}px over ${compared}; worst vertex error ${vertexWorst} over ${vertices}`);
  }
  if (carryDis > 0) ok('V1c falsifier', `carry-forward disagrees at ${carryDis} columns (test discriminates)`);
  else bad('V1c falsifier', 'carry-forward agreed at every column — V1c does not discriminate');
}

/* ── V2c ── Selection never moves the career axis; the range does ───────────── */
function v2c() {
  const c = careerCase('windexcup');
  const ids = M.activeLinesOf(c.season).map((l) => l.id);
  const selections = [[], [ids[0]], [ids[1]], [ids[ids.length - 1]], ids.slice(0, 2), ids.slice(0, M.MAX_SELECTED)];
  const domains = selections.map((sel) => {
    void M.assignHues(ids, sel);
    const s = M.makeScales(SVG_W, c.data.yMin, c.data.yMax);
    return [c.data.yMin, c.data.yMax, s.toSvgY(0), s.plotY(100)].join('|');
  });
  if (domains.every((d) => d === domains[0])) ok('V2c selection', `domain [${c.data.yMin}, ${c.data.yMax}] identical across ${selections.length} selection states`);
  else bad('V2c selection', `domain moved with selection: ${JSON.stringify(domains)}`);

  if (M.buildCareerData.length === 3) ok('V2c signature', 'buildCareerData takes no selection argument');
  else bad('V2c signature', `buildCareerData arity ${M.buildCareerData.length}, expected 3`);

  // Every career line sits inside the domain: All time covers every line and never clamps.
  const outside = M.activeLinesOf(c.data).filter((l) => l.points.some((p) => p.y < c.data.yMin || p.y > c.data.yMax)).length;
  const moved = c.data.yMin !== c.season.yMin || c.data.yMax !== c.season.yMax;
  if (outside === 0 && moved) ok('V2c range', `axis moved: Season [${c.season.yMin}, ${c.season.yMax}] -> All time [${c.data.yMin}, ${c.data.yMax}]; no line outside it`);
  else bad('V2c range', `moved=${moved}, ${outside} lines outside the domain`);
}

/* ── V3c ── Season gridlines under the vertices, labels centred per slot ────── */
function v3c() {
  const c = careerCase('windexcup');
  const s = M.makeScales(SVG_W, c.data.yMin, c.data.yMax);
  const ticks = M.buildCareerTicks(c.spans, c.toX);
  const grid = ticks.filter((t) => t.grid !== false);
  const labels = ticks.filter((t) => t.grid === false);
  const finished = c.spans.filter((sp) => !sp.toDate);
  const problems = [];

  if (grid.length !== finished.length) problems.push(`${grid.length} gridlines for ${finished.length} finished seasons`);
  let onVertex = 0;
  finished.forEach((sp, i) => {
    const vx = c.toX(sp.vertexDate);
    if (!grid[i] || grid[i].nx !== vx || grid[i].label !== '') problems.push(`gridline ${i} at ${grid[i] && grid[i].nx}, vertex at ${vx}`);
    for (const l of M.activeLinesOf(c.data)) {
      const p = l.points.find((q) => q.date === sp.vertexDate);
      if (!p) continue;
      if (p.x !== vx) problems.push(`${l.id} vertex ${sp.vertexDate} at ${p.x}, gridline ${vx}`);
      else onVertex++;
    }
  });

  if (labels.length !== c.spans.length) problems.push(`${labels.length} labels for ${c.spans.length} seasons`);
  c.spans.forEach((sp, i) => {
    const from = i === 0 ? 0 : c.toX(c.spans[i - 1].end);
    const mid = new Date((M.dayMs(sp.start) + M.dayMs(sp.end)) / 2).getFullYear();
    const t = labels[i];
    if (!t || t.nx !== (from + c.toX(sp.end)) / 2 || t.label !== String(mid)) problems.push(`label ${i} ${JSON.stringify(t)}, want ${mid} at slot centre`);
  });
  if (c.toX(c.spans[c.spans.length - 1].end) !== 1) problems.push('the last season does not end the axis');
  let minGap = Infinity;
  for (let i = 1; i < labels.length; i++) minGap = Math.min(minGap, s.plotW * (labels[i].nx - labels[i - 1].nx));
  if (minGap < 30) problems.push(`labels ${minGap.toFixed(1)}px apart`);

  if (problems.length === 0) ok('V3c windexcup', `${grid.length} gridlines each under ${onVertex} vertices exactly; ${labels.length} labels centred per slot (${labels.map((t) => t.label).join(' ')}), >= ${minGap.toFixed(0)}px apart`);
  else bad('V3c windexcup', problems.slice(0, 4).join('; '));

  // Regression arm: seasons are not equal widths (2020 and 2024 hold a Feb 29), so an
  // even i/n spacing must drift — otherwise this could not catch a second mapping.
  const drift = Math.max(...finished.map((sp, i) => Math.abs(c.toX(sp.vertexDate) - (i + 1) / c.spans.length)));
  if (drift > 1e-4) ok('V3c regression', `even i/n spacing would drift ${drift.toFixed(5)} nx`);
  else bad('V3c regression', `even spacing drift only ${drift} — test would not catch a second mapping`);
}

/* ── V7c ── Degenerate and boundary states ─────────────────────────────────── */
function v7c() {
  // a. A season that has not started never produces a vertex.
  for (const key of FIXTURES) {
    const c = careerCase(key);
    const future = c.a.seasons.filter((sp) => sp.start_date > TODAY);
    const futureRows = c.a.rows.filter((r) => future.some((sp) => sp.id === r.season_id)).length;
    const leaked =
      c.spans.filter((sp) => sp.start > TODAY).length +
      c.data.dates.filter((d) => d > TODAY).length +
      c.data.lines.reduce((n, l) => n + l.points.filter((p) => p.date > TODAY).length, 0);
    // Arm: the same build with the future season kept, as a season just begun.
    const kept = [...c.spans, ...M.careerSpans(future, future.length ? future[0].start_date : TODAY)];
    const armLeaks = M.buildCareerData(c.a.rows, kept, c.players).lines.reduce((n, l) => n + l.points.filter((p) => p.date > TODAY).length, 0);
    const name = `V7c-a ${key}`;
    if (future.length > 0 && futureRows > 0 && leaked === 0 && armLeaks > 0) {
      ok(name, `${future.length} unstarted season with ${futureRows} rows dropped, 0 vertices past ${TODAY}; kept, it would add ${armLeaks}`);
    } else {
      bad(name, `unstarted seasons ${future.length}, rows ${futureRows}, leaked ${leaked}, arm ${armLeaks} (want >0, >0, 0, >0)`);
    }
  }

  // a2. "Started" is decided on the chart's own date, at the day boundary.
  {
    const yesterday = M.windowStartOf(TODAY, 1);
    const tomorrow = M.windowStartOf(TODAY, -1);
    const today = M.careerSpans(seasonsOf(['old', '2025-08-11', yesterday], ['new', TODAY, '2027-08-10']), TODAY);
    const notYet = M.careerSpans(seasonsOf(['old', '2025-08-12', TODAY], ['new', tomorrow, '2027-08-11']), TODAY);
    const okToday = today.map((sp) => sp.id).join() === 'old,new' && !today[0].toDate && today[1].toDate && today[1].vertexDate === TODAY;
    const okNotYet = notYet.map((sp) => sp.id).join() === 'old' && notYet[0].toDate && notYet[0].vertexDate === TODAY;
    if (okToday && okNotYet) ok('V7c-a boundary', 'a season starting today is plotted and in progress; one starting tomorrow is not, and the last day of the old one is still to date');
    else bad('V7c-a boundary', `starts today ${JSON.stringify(today)}; starts tomorrow ${JSON.stringify(notYet)}`);
  }

  // b. The enable rule.
  {
    const wc = careerCase('windexcup');
    const wcPast = careerCase('windexcup', wc.spans.find((sp) => !sp.toDate).id);
    const yc = careerCase('ycwindex');
    const ycPlotted = new Set(yc.players.map((p) => p.player_id));
    const rowRule = new Set(yc.a.rows.filter((r) => ycPlotted.has(r.player_id)).map((r) => r.season_id)).size >= M.MIN_CAREER_SEASONS;
    const sp = M.careerSpans(seasonsOf(['a', '2024-01-01', '2024-12-31'], ['b', '2025-01-01', '2025-12-31'], ['c', '2026-01-01', '2026-12-31']), TODAY);
    const two = M.careerEnabled(sp, [crow('b', 'p0', 5), crow('c', 'p0', 3)], ['p0'], 'c');
    const zeroRounds = M.careerEnabled(sp, [crow('b', 'p0', 0, 0), crow('c', 'p0', 3)], ['p0'], 'c');
    const otherPlayer = M.careerEnabled(sp, [crow('b', 'p9', 5), crow('c', 'p0', 3)], ['p0'], 'c');
    const noneInProgress = M.careerEnabled(
      M.careerSpans(seasonsOf(['a', '2024-01-01', '2024-12-31'], ['b', '2025-01-01', '2025-12-31']), TODAY),
      [crow('a', 'p0', 5), crow('b', 'p0', 3)], ['p0'], 'b',
    );
    if (wc.enabled && !wcPast.enabled && !yc.enabled && rowRule && two && !zeroRounds && !otherPlayer && !noneInProgress) {
      ok('V7c-b enable', 'windexcup on for its season in progress, off on a finished one; ycwindex (one season played) off, where counting rows would turn it on; synthetic: two played seasons on, a 0-round season or another player\'s does not count, no season in progress off');
    } else {
      bad('V7c-b enable', `wc=${wc.enabled} wcPast=${wcPast.enabled} yc=${yc.enabled} rowRule=${rowRule} two=${two} zeroRounds=${zeroRounds} otherPlayer=${otherPlayer} noneInProgress=${noneInProgress}`);
    }
  }

  // c. Joiners: "joined 2026", never a 0 in a league they were not in.
  {
    const c = careerCase('windexcup');
    const s = M.makeScales(SVG_W, c.data.yMin, c.data.yMax);
    const lines = M.activeLinesOf(c.data);
    const joiners = lines.filter((l) => c.data.firstSpan.get(l.id) > 0);
    const cursors = [M.PAD_T + 20, M.PAD_T + 130, M.PAD_T + 240];
    const problems = [];
    let preJoin = 0;
    for (const l of joiners) {
      const first = c.data.firstSpan.get(l.id);
      c.data.dates.forEach((d, k) => {
        const row = M.buildCareerTooltipRows(c.data, d, [l.id], M.PAD_T + 130, s).find((r) => r.id === l.id);
        if (k < first) {
          preJoin++;
          if (!row || row.joined !== c.spans[first].label || row.svgY !== null) problems.push(`${l.id} @ ${d}: ${JSON.stringify(row)}`);
          if (cursors.some((cy) => M.buildCareerTooltipRows(c.data, d, [], cy, s).some((r) => r.id === l.id))) problems.push(`${l.id} in the nearest-5 before joining @ ${d}`);
        } else if (!row || row.joined || row.svgY === null) {
          problems.push(`${l.id} @ ${d} after joining: ${JSON.stringify(row)}`);
        }
      });
    }
    // Arm: plain buildTooltipRows, the season before a joiner's first, reports 0 with a dot.
    const j = joiners[0];
    const before = j ? c.data.dates[c.data.firstSpan.get(j.id) - 1] : TODAY;
    const invented = j ? M.buildTooltipRows(lines, c.toX(before), [j.id], M.PAD_T, s).find((r) => r.id === j.id) : null;
    const thisSeason = joiners.filter((l) => c.spans[c.data.firstSpan.get(l.id)].toDate).length;
    if (problems.length === 0 && preJoin > 0 && thisSeason > 0 && invented && invented.value === 0 && invented.svgY !== null) {
      ok('V7c-c joiners', `${joiners.length} players joined after the first season (${thisSeason} this season): a "joined" row with no dot at ${preJoin} earlier seasons, never in the nearest-5; plain rows would show 0 with a dot`);
    } else {
      bad('V7c-c joiners', `${problems.slice(0, 3).join('; ')} preJoin=${preJoin} thisSeason=${thisSeason} invented=${JSON.stringify(invented)}`);
    }
  }

  // d. A season sat out carries the total flat, with its own vertex.
  {
    const sp = M.careerSpans(seasonsOf(['a', '2023-12-01', '2024-11-30'], ['b', '2024-12-01', '2025-11-30'], ['c', '2025-12-01', '2026-11-30']), TODAY);
    const d = M.buildCareerData([crow('a', 'p0', 10), crow('c', 'p0', 5)], sp, people(1));
    const l = d.lines[0];
    if (l.points.map((p) => p.y).join() === '0,10,10,15' && l.points[2].date === '2025-11-30' && l.playedDates.length === 2) {
      ok('V7c-d sat-out', 'vertices 0, 10, 10, 15: flat through the missed season, which keeps its vertex');
    } else {
      bad('V7c-d sat-out', `points ${JSON.stringify(l.points)} played ${l.playedDates}`);
    }
  }

  // e. The first day of a new season: on, labelled, and reachable.
  {
    const next = fixture.alltime.windexcup.seasons.find((sp) => sp.start_date > TODAY);
    const c = careerCase('windexcup', next.id, next.start_date);
    const last = c.spans[c.spans.length - 1];
    const prev = c.spans[c.spans.length - 2];
    const s = M.makeScales(SVG_W, c.data.yMin, c.data.yMax);
    const labels = M.buildCareerTicks(c.spans, c.toX).filter((t) => t.grid === false);
    const gapPx = s.plotW * (labels[labels.length - 1].nx - labels[labels.length - 2].nx);
    const snapped = M.nearestDate(c.data.dates, c.toX, s, s.toSvgX(c.toX(last.vertexDate)));
    const header = M.careerHeaderAt(c.data, last.vertexDate);
    const rows = M.buildCareerTooltipRows(c.data, last.vertexDate, [], M.PAD_T + 130, s);
    const flat = M.activeLinesOf(c.data).every((l) => l.points[l.points.length - 1].y === l.points[l.points.length - 2].y);
    const problems = [];
    if (!c.enabled) problems.push('not enabled');
    if (!(last.toDate && last.vertexDate === next.start_date && !prev.toDate)) problems.push(`last span ${JSON.stringify(last)}`);
    if (!(c.toX(last.vertexDate) > c.toX(prev.vertexDate))) problems.push("today's vertex is not right of the last season's");
    if (snapped !== next.start_date) problems.push(`snaps to ${snapped}`);
    if (header !== `${last.label} season to date` || M.careerHeaderAt(c.data, prev.vertexDate) !== `${prev.label} season`) problems.push(`headers "${header}" / "${M.careerHeaderAt(c.data, prev.vertexDate)}"`);
    if (gapPx < 30) problems.push(`last two labels ${gapPx.toFixed(1)}px apart`);
    if (!flat || rows.length === 0 || !finiteDomain(c.data)) problems.push(`flat=${flat} rows=${rows.length} finite=${finiteDomain(c.data)}`);
    if (problems.length === 0) ok('V7c-e rollover day', `${next.start_date}: on, "${header}", snaps to today rather than ${prev.label}'s vertex, labels ${gapPx.toFixed(0)}px apart, every line flat into the new season`);
    else bad('V7c-e rollover day', problems.join('; '));
  }

  // f. A plotted player with no rows, and no seasons at all.
  {
    const sp = M.careerSpans(seasonsOf(['a', '2025-01-01', '2025-12-31'], ['b', '2026-01-01', '2026-12-31']), TODAY);
    const d = M.buildCareerData([crow('a', 'p0', 7), crow('b', 'p0', -2)], sp, people(2));
    const p1 = d.lines.find((l) => l.id === 'p1');
    const none = M.buildCareerData([crow('a', 'p0', 7)], [], people(1));
    if (p1.points.length === 0 && !d.firstSpan.has('p1') && M.activeLinesOf(d).length === 1 && finiteDomain(d) &&
        none.lines.every((l) => l.points.length === 0) && none.yMin === -10 && none.yMax === 10 && M.careerToX([])('2026-01-01') === 0) {
      ok('V7c-f empty', 'a player with no rows draws nothing; no seasons -> no lines, domain [-10, 10], no throw');
    } else {
      bad('V7c-f empty', `p1 pts=${p1.points.length} active=${M.activeLinesOf(d).length} none=[${none.yMin}, ${none.yMax}]`);
    }
  }

  // g. Joining on a season's first day, with a round that day: the start shares x with
  //    the vertex, so it is dropped — or valueAt, and the tooltip, would read its 0.
  {
    const sp = M.careerSpans(seasonsOf(['a', '2025-08-11', M.windowStartOf(TODAY, 1)], ['b', TODAY, '2027-08-10']), TODAY);
    const d = M.buildCareerData([crow('a', 'p0', 5), crow('b', 'p0', 2), crow('b', 'p1', 4)], sp, people(2));
    const p1 = d.lines.find((l) => l.id === 'p1');
    const s = M.makeScales(SVG_W, d.yMin, d.yMax);
    const row = M.buildCareerTooltipRows(d, TODAY, ['p1'], M.PAD_T, s).find((r) => r.id === 'p1');
    const x = M.careerToX(sp)(TODAY);
    const kept = M.valueAt([{ x, y: 0, date: TODAY }, { x, y: 4, date: TODAY }], x);
    if (p1.points.length === 1 && p1.points[0].y === 4 && row && row.value === 4 && kept === 0) {
      ok('V7c-g first-day joiner', 'one vertex at 4 and the tooltip reads 4; with the start kept, valueAt would read 0');
    } else {
      bad('V7c-g first-day joiner', `points ${JSON.stringify(p1.points)} row ${JSON.stringify(row)} kept ${kept}`);
    }
  }
}

/* ── V9c ── Career tooltip order; joined rows last ─────────────────────────── */
function v9c() {
  const c = careerCase('windexcup');
  const s = M.makeScales(SVG_W, c.data.yMin, c.data.yMax);
  const lines = M.activeLinesOf(c.data);
  const ids = lines.map((l) => l.id);
  const firstOf = (id) => c.data.firstSpan.get(id);
  const joiners = ids.filter((id) => firstOf(id) > 0);
  const selections = [[], ids.slice(0, 2), ids.slice(0, M.MAX_SELECTED), joiners.slice(0, M.MAX_SELECTED)];
  const cursors = [M.PAD_T + 20, M.PAD_T + 130, M.PAD_T + 240];
  let checked = 0;
  let order = 0;
  let pixel = 0;
  let placement = 0;
  let maxRows = 0;
  let joinedRows = 0;
  for (const sel of selections) {
    for (const cy of cursors) {
      for (const d of c.data.dates) {
        const rows = M.buildCareerTooltipRows(c.data, d, sel, cy, s);
        maxRows = Math.max(maxRows, rows.length);
        const firstJoined = rows.findIndex((r) => r.joined);
        if (firstJoined !== -1 && rows.slice(firstJoined).some((r) => !r.joined)) placement++;
        if (sel.length === 0 && firstJoined !== -1) placement++;
        if (sel.length > 0 && rows.map((r) => r.id).sort().join() !== [...sel].sort().join()) placement++;
        if (rows.some((r) => r.ended)) placement++;
        const positioned = rows.filter((r) => !r.joined);
        for (let i = 1; i < positioned.length; i++) {
          const a = positioned[i - 1];
          const b = positioned[i];
          if (b.svgY < a.svgY - 1e-9 || (Math.abs(b.svgY - a.svgY) <= 1e-9 && b.value > a.value)) order++;
        }
        for (const row of positioned) {
          const line = lines.find((l) => l.id === row.id);
          if (Math.abs(s.plotY(M.valueAt(line.points, c.toX(d))) - row.svgY) > 1e-9) pixel++;
        }
        const joined = rows.filter((r) => r.joined);
        for (let i = 1; i < joined.length; i++) if (firstOf(joined[i].id) < firstOf(joined[i - 1].id)) order++;
        joinedRows += joined.length;
        checked++;
      }
    }
  }
  if (order + pixel + placement === 0 && maxRows <= M.MAX_TOOLTIP_ROWS && joinedRows > 0) {
    ok('V9c windexcup', `${checked} states: order svgY then value, dots on the vertex, exactly the selection when there is one, ${joinedRows} joined rows all last and earliest first, max ${maxRows} rows`);
  } else {
    bad('V9c windexcup', `order ${order}, pixel ${pixel}, placement ${placement}, joined rows ${joinedRows}, max rows ${maxRows}`);
  }
}

/* ── V13c ── The career line agrees with the All Time leaderboard, two ways ─────
 * Leaderboard path: every started season's standings merged per player, as
 * standings.tsx computes All Time. Raw path: fixture rawScoreTotals, summed from
 * league_scores with no view and no membership join. The two must agree with each
 * other, and every career line must end on both.
 */
function v13c() {
  for (const key of FIXTURES) {
    const c = careerCase(key);
    const a = c.a;
    const stored = new Map(a.allTimeLeaderboard.map((e) => [e.player_id, e.total_points]));
    const raw = new Map(a.rawScoreTotals.map((e) => [e.player_id, e.total_points]));
    const started = a.seasons.filter((sp) => sp.start_date <= TODAY).sort((x, y) => x.start_date.localeCompare(y.start_date)).map((sp) => sp.id);
    const merged = new Map();
    for (const r of a.rows) if (started.includes(r.season_id)) merged.set(r.player_id, (merged.get(r.player_id) ?? 0) + r.total_points);

    const problems = [];
    const near = (x, y) => typeof x === 'number' && typeof y === 'number' && Math.abs(x - y) < 1e-9;
    if (merged.size !== stored.size || merged.size !== raw.size) problems.push(`players: leaderboard path ${merged.size}, stored ${stored.size}, raw ${raw.size}`);
    for (const [id, total] of merged) {
      if (!near(total, stored.get(id))) problems.push(`${id} leaderboard path ${total} vs stored ${stored.get(id)}`);
      if (!near(total, raw.get(id))) problems.push(`${id} leaderboard path ${total} vs raw ${raw.get(id)}`);
    }

    const seasonLines = new Map(M.activeLinesOf(c.season).map((l) => [l.id, l]));
    let careers = 0;
    let vertices = 0;
    for (const l of M.activeLinesOf(c.data)) {
      const final = l.points[l.points.length - 1].y;
      if (!near(final, merged.get(l.id)) || !near(final, raw.get(l.id))) problems.push(`${l.id} career ends ${final}, leaderboard ${merged.get(l.id)}, raw ${raw.get(l.id)}`);
      // Every vertex is the sum of that player's seasons through it.
      const first = c.data.firstSpan.get(l.id);
      const vs = l.points.slice(l.points.length - (started.length - first));
      started.slice(first).forEach((sid, j) => {
        const want = a.rows.filter((r) => r.player_id === l.id && started.indexOf(r.season_id) >= 0 && started.indexOf(r.season_id) <= first + j).reduce((t, r) => t + r.total_points, 0);
        if (!vs[j] || !near(vs[j].y, want)) problems.push(`${l.id} vertex ${j} ${vs[j] && vs[j].y}, want ${want}`);
        vertices++;
      });
      // The season in progress, against the Season chart's own line.
      const before = l.points.length > 2 ? l.points[l.points.length - 2].y : 0;
      // No Season line means no points yet this season: 0.
      const sl = seasonLines.get(l.id);
      const seasonTotal = sl ? sl.points[sl.points.length - 1].y : 0;
      if (!near(final - before, seasonTotal)) problems.push(`${l.id} season ${final - before} vs Season chart ${seasonTotal}`);
      careers++;
    }
    if (problems.length === 0 && careers > 0) {
      ok(`V13c ${key}`, `${merged.size} players: leaderboard path == stored leaderboard == raw score sums; ${careers} career lines end on it, ${vertices} vertices each their seasons' sum, season in progress == Season chart`);
    } else {
      bad(`V13c ${key}`, problems.slice(0, 4).join('; ') || 'no career lines');
    }
  }

  // Falsifier: half points truncated, as an integer read of total_points would, must
  // leave some career off the leaderboard — the 2021 and 2022 halves are real.
  const c = careerCase('windexcup');
  const stored = new Map(c.a.allTimeLeaderboard.map((e) => [e.player_id, e.total_points]));
  const truncated = M.buildCareerData(c.a.rows.map((r) => ({ ...r, total_points: Math.trunc(r.total_points) })), c.spans, c.players);
  const off = M.activeLinesOf(truncated).filter((l) => l.points[l.points.length - 1].y !== stored.get(l.id)).length;
  if (off > 0) ok('V13c falsifier', `truncating half points puts ${off} careers off the leaderboard (test discriminates)`);
  else bad('V13c falsifier', 'truncated half points still reconcile — V13c cannot see them');
}

/* ── V-pills-c ── One pill set in every range ──────────────────────────────── */
function vPillsC() {
  for (const key of FIXTURES) {
    const c = careerCase(key);
    const seasonIds = M.activeLinesOf(c.season).map((l) => l.id);
    const careerIds = M.activeLinesOf(c.data).map((l) => l.id);
    const models = ['season', 'd10', 'd4', 'career'].map((requested) =>
      M.historyModel({ season: c.season, careerRows: c.a.rows, spans: c.spans, standings: c.f.standings, seasonId: c.seasonId, todayIso: TODAY, requested }),
    );
    const pills = models[0].pills.map((p) => p.id);
    const oneSet = new Set(models.map((m) => m.pills.map((p) => p.id).join())).size === 1;
    const standingsOrder = c.f.standings.map((p) => p.player_id).filter((id) => pills.includes(id)).join() === pills.join();
    const covered = seasonIds.every((id) => pills.includes(id)) && (!c.enabled || careerIds.every((id) => pills.includes(id)));
    const exact = pills.every((id) => seasonIds.includes(id) || (c.enabled && careerIds.includes(id)));
    if (oneSet && standingsOrder && covered && exact) {
      ok(`V-pills-c ${key}`, `${pills.length} pills, the same in all 4 ranges, standings order: every player with a Season line${c.enabled ? ` or a career line (${careerIds.length})` : ' (All time off)'} and no one else`);
    } else {
      bad(`V-pills-c ${key}`, `oneSet=${oneSet} standingsOrder=${standingsOrder} covered=${covered} exact=${exact} pills ${pills.join()}`);
    }
  }
}

/* ── V-reach ── All time is reachable when Season has nothing to draw ─────────
 * HistoryChart renders from historyModel() and nothing else: the "No history data."
 * gate, the range toggle's options and value, and the pills. The pure half runs the
 * model on the first day of a season, before anyone has scored. The static half parses
 * the component and proves it renders from the model — with an arm that parses the
 * pre-fix component out of git, which gated the whole chart on Season lines, and must
 * fail the same parse.
 */
const PRE_REACH_COMMIT = '432eb72';

function componentRendersFromModel(ts, text, fileName) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const gates = [];
  const toggles = [];
  const pillMaps = [];
  const visit = (node) => {
    if (ts.isIfStatement(node) && node.thenStatement.getText(sf).includes('No history data.')) gates.push(node.expression.getText(sf));
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(sf) === 'SegmentedToggle') {
      const attr = (n) => {
        const a = node.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === n);
        return a && a.initializer ? a.initializer.getText(sf) : null;
      };
      toggles.push({ options: attr('options'), value: attr('value') });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.getText(sf) === 'map' && node.getText(sf).includes('togglePlayer')) {
      pillMaps.push(node.expression.expression.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const problems = [];
  if (!/historyModel\(/.test(text)) problems.push('never calls historyModel');
  if (gates.length !== 1 || !/\bmodel\b/.test(gates[0]) || /activeLines/.test(gates[0])) problems.push(`"No history data." gated on ${JSON.stringify(gates)}`);
  if (toggles.length !== 1 || toggles[0].options !== '{model.options}' || toggles[0].value !== '{model.range}') problems.push(`range toggle ${JSON.stringify(toggles)}`);
  if (pillMaps.length !== 1 || pillMaps[0] !== 'model.pills') problems.push(`pills mapped from ${JSON.stringify(pillMaps)}`);
  return problems;
}

function vReach() {
  // Day one of Windex Cup's next season: 0 Season lines, seven seasons played.
  {
    const f = fixture.windexcup;
    const a = fixture.alltime.windexcup;
    const next = a.seasons.find((sp) => sp.start_date > TODAY);
    const day = next.start_date;
    const season = M.buildChartData([], f.standings, day, day);
    const spans = M.careerSpans(a.seasons, day);
    const m = M.historyModel({ season, careerRows: a.rows, spans, standings: f.standings, seasonId: next.id, todayIso: day, requested: 'season' });
    const opt = Object.fromEntries(m.options.map((o) => [o.key, o]));
    const played = new Set(a.rows.filter((r) => r.rounds_played > 0 && spans.some((sp) => sp.id === r.season_id)).map((r) => r.season_id)).size;
    const problems = [];
    if (M.activeLinesOf(season).length !== 0) problems.push('precondition: the Season chart has lines');
    if (played < M.MIN_CAREER_SEASONS) problems.push(`precondition: ${played} seasons played`);
    if (m.range !== 'career') problems.push(`draws ${m.range}`);
    if (opt.career.disabled || opt.career.label !== 'All time') problems.push(`All time option ${JSON.stringify(opt.career)}`);
    if (!opt.season.disabled || !opt.d10.disabled || !opt.d4.disabled) problems.push('a Season range is on with no Season lines');
    if (!m.career || M.activeLinesOf(m.career).length !== f.standings.length || m.pills.length !== f.standings.length) problems.push(`career lines ${m.career && M.activeLinesOf(m.career).length}, pills ${m.pills.length}`);
    if (problems.length === 0) ok('V-reach day one', `${day}, 0 Season lines, ${played} seasons played: asked for Season, draws All time; Season, 10 days, 4 days off; ${m.pills.length} pills from career lines`);
    else bad('V-reach day one', problems.join('; '));
  }

  // Nothing on offer: YC Windex's next season, day one, one season played. The chart
  // says so rather than drawing an empty axis.
  {
    const y = fixture.ycwindex;
    const ya = fixture.alltime.ycwindex;
    const next = ya.seasons.find((sp) => sp.start_date > TODAY);
    const m = M.historyModel({
      season: M.buildChartData([], y.standings, next.start_date, next.start_date),
      careerRows: ya.rows,
      spans: M.careerSpans(ya.seasons, next.start_date),
      standings: y.standings,
      seasonId: next.id,
      todayIso: next.start_date,
      requested: 'career',
    });
    if (m.range === null && m.options.every((o) => o.disabled) && m.pills.length === 0) ok('V-reach nothing on offer', `ycwindex ${next.start_date}: no range on offer, range null -> "No history data."`);
    else bad('V-reach nothing on offer', `range ${m.range}, options ${JSON.stringify(m.options)}, pills ${m.pills.length}`);
  }

  // Mid-season the model reproduces the old rules: the three Season ranges on exactly
  // when they were, an unavailable ask falls back to Season.
  {
    const problems = [];
    for (const key of FIXTURES) {
      const c = careerCase(key);
      for (const requested of ['season', 'd10', 'd4', 'career']) {
        const m = M.historyModel({ season: c.season, careerRows: c.a.rows, spans: c.spans, standings: c.f.standings, seasonId: c.seasonId, todayIso: TODAY, requested });
        const opt = Object.fromEntries(m.options.map((o) => [o.key, o]));
        const old = { season: true };
        for (const rk of WINDOWS) old[rk] = M.rangeHasRounds(c.season.dates, M.windowStartOf(TODAY, M.RANGE_DAYS[rk]), TODAY);
        old.career = c.enabled;
        for (const rk of ['season', 'd10', 'd4', 'career']) if (opt[rk].disabled === old[rk]) problems.push(`${key} ${rk} disabled=${opt[rk].disabled}`);
        const want = old[requested] ? requested : 'season';
        if (m.range !== want) problems.push(`${key} asked ${requested}, draws ${m.range}, want ${want}`);
      }
    }
    if (problems.length === 0) ok('V-reach mid-season', 'both leagues, all 4 asks: options on exactly as the pre-model rules, an ask off offer falls back to Season');
    else bad('V-reach mid-season', problems.slice(0, 4).join('; '));
  }

  // Static half: the component renders from the model. Arm: the pre-fix component fails.
  const ts = require(path.join(EXPO, 'node_modules', 'typescript'));
  const now = componentRendersFromModel(ts, fs.readFileSync(COMPONENT, 'utf8'), 'HistoryChart.tsx');
  if (now.length === 0) ok('V-reach component', 'HistoryChart gates "No history data." on the model, and takes the toggle options, its value and the pills from it');
  else bad('V-reach component', now.join('; '));
  const before = componentRendersFromModel(
    ts,
    execFileSync('git', ['show', `${PRE_REACH_COMMIT}:windex-expo/components/HistoryChart.tsx`], { cwd: EXPO, encoding: 'utf8', stdio: 'pipe' }),
    'HistoryChart@pre.tsx',
  );
  if (before.some((p) => p.startsWith('"No history data." gated on'))) ok('V-reach arm', `HistoryChart@${PRE_REACH_COMMIT}, which hid the chart without Season lines, fails the same parse (${before.length} problems)`);
  else bad('V-reach arm', `HistoryChart@${PRE_REACH_COMMIT} passes the gate parse — the check cannot see the bug: ${before.join('; ')}`);
}

/* ── Run ───────────────────────────────────────────────────────────────────── */
console.log('\n=== V1  interpolation vs rendered pixel ===');
run('V1 windexcup', () => v1('windexcup'));
run('V1 ycwindex', () => v1('ycwindex'));
console.log('\n=== V2  y-domain invariance under selection ===');
run('V2 windexcup', () => v2('windexcup'));
console.log('\n=== V3  month gridline alignment ===');
run('V3 windexcup', () => v3('windexcup'));
run('V3 ycwindex', () => v3('ycwindex'));
console.log('\n=== V5  no literal hex in component ===');
run('V5', v5);
console.log('\n=== V7  degenerate states ===');
run('V7', v7);
console.log('\n=== V9  tooltip row order == visual line order ===');
run('V9 windexcup', () => v9('windexcup'));
run('V9 ycwindex', () => v9('ycwindex'));
console.log('\n=== Hue assignment ===');
run('Hues windexcup', () => vHues('windexcup'));

console.log('\n=== V1w  windowed interpolation vs rendered pixel, every column ===');
run('V1w', v1w);
console.log('\n=== V2w  range moves the axis, selection never does ===');
run('V2w', v2w);
console.log('\n=== V7w  degenerate windows ===');
run('V7w', v7w);
console.log('\n=== V9w  windowed tooltip order ===');
run('V9w', v9w);
console.log('\n=== V13  Season and window agree at the same moment ===');
run('V13', v13);
console.log('\n=== V-pills  players, order, hues across ranges ===');
run('V-pills', vPills);
console.log('\n=== V-clamp  clamping is exact ===');
run('V-clamp', vClamp);
console.log('\n=== All time  V-order  seasons in start_date order, never id ===');
run('V-order', vOrder);
console.log('\n=== V1c  career interpolation vs rendered pixel ===');
run('V1c', v1c);
console.log('\n=== V2c  selection never moves the career axis ===');
run('V2c', v2c);
console.log('\n=== V3c  season gridlines and labels ===');
run('V3c', v3c);
console.log('\n=== V7c  degenerate and boundary states ===');
run('V7c', v7c);
console.log('\n=== V9c  career tooltip order ===');
run('V9c', v9c);
console.log('\n=== V13c  career == All Time leaderboard, two ways ===');
run('V13c', v13c);
console.log('\n=== V-pills-c  one pill set in every range ===');
run('V-pills-c', vPillsC);
console.log('\n=== V-reach  All time reachable with no Season lines ===');
run('V-reach', vReach);
console.log(`\n=== V12  Season unchanged vs ${BASELINE_COMMIT} ===`);
run('V12', v12);
console.log(`\n=== V14  Standings toggle identical to ${BASELINE_COMMIT} (static) ===`);
run('V14', v14);
// Last: it switches process.env.TZ, and verifies it restored it.
console.log('\n=== V3w  day ticks on toX, DST included ===');
run('V3w', v3w);

console.log(failures === 0 ? '\nALL HEADLESS CHECKS PASS\n' : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
