import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, LayoutChangeEvent, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line as SvgLine, Polyline, Text as SvgText } from 'react-native-svg';
import { getApiBase, getSupabaseAnonKey } from '@/lib/config';
import { getStoredAccessToken, type StandingRow } from '@/lib/api';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { SegmentedToggle } from '@/components/SegmentedToggle';
import {
  CHART_H,
  CHART_SERIES_DARK,
  CHART_SERIES_LIGHT,
  MAX_SELECTED,
  PAD_B,
  PAD_L,
  PAD_R,
  PAD_T,
  RANGE_DAYS,
  activeLinesOf,
  assignHues,
  buildCareerTicks,
  buildCareerTooltipRows,
  buildChartData,
  buildDayTicks,
  buildMonthTicks,
  buildTooltipRows,
  buildWindowTooltipRows,
  careerHeaderAt,
  careerSpans,
  careerToX,
  formatDay,
  formatFull,
  formatSigned,
  historyModel,
  isoOf,
  makeScales,
  makeToX,
  nearestDate,
  niceTickValues,
  playedInWindow,
  polylinePoints,
  seasonAxisEnd,
  windowChartData,
  windowHeader,
  windowStartOf,
  type CareerRow,
  type ChartData,
  type MonthTick,
  type RangeKey,
  type ScoreRow,
  type SeasonLike,
} from '@/lib/historyChartMath';

type Props = {
  seasonId: string;
  groupId: string;
  standings: StandingRow[];
  seasonStartDate: string;
  seasonEndDate: string;
  /** The group's seasons, for All time. Unstarted ones may be included; careerSpans drops them. */
  seasons: SeasonLike[];
};

type RangeView = {
  data: ChartData;
  toX: (date: string) => number;
  ticks: MonthTick[];
  /** Snap domain, limited to what toX spans. */
  dates: string[];
};

const TOOLTIP_W = 168;
const TOOLTIP_PAD = 8;
const TOOLTIP_HEADER_H = 20;
const TOOLTIP_ROW_H = 17;

/** 10 days / 4 days. Both are open at the device check. A resting player lies under the
 *  baseline, so only RESTING_STROKE - BASELINE_STROKE of it shows, split either side:
 *  if that soft edge reads as a glitch rather than as players resting, 1.5 merges it
 *  into the baseline. If the baseline reads too light in light mode, 1.25. */
const RESTING_STROKE = 2.5;
const BASELINE_STROKE = 1;

async function fetchSeasonScores(seasonId: string, groupId: string): Promise<ScoreRow[]> {
  const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
  const token = await getStoredAccessToken();
  const anonKey = getSupabaseAnonKey();
  if (!base || !token) return [];
  const headers = { Authorization: `Bearer ${token}`, apikey: anonKey || token };

  const roundsRes = await fetch(
    `${base}/rest/v1/league_rounds?group_id=eq.${encodeURIComponent(groupId)}&season_id=eq.${encodeURIComponent(seasonId)}&select=id,round_date&order=round_date.asc`,
    { headers },
  );
  if (!roundsRes.ok) return [];
  const rounds: { id: string; round_date: string }[] = await roundsRes.json();
  if (rounds.length === 0) return [];

  const roundDateMap = new Map(rounds.map((r) => [r.id, r.round_date]));
  const roundIds = rounds.map((r) => r.id);
  const allScores: ScoreRow[] = [];
  const BATCH = 100;

  for (let i = 0; i < roundIds.length; i += BATCH) {
    const batch = roundIds.slice(i, i + BATCH);
    const inList = batch.map((id) => `"${id}"`).join(',');
    const res = await fetch(
      `${base}/rest/v1/league_scores?league_round_id=in.(${inList})&select=player_id,score_value,score_override,league_round_id`,
      { headers },
    );
    if (!res.ok) continue;
    const rows: { player_id: string; score_value: number | null; score_override: number | null; league_round_id: string }[] =
      await res.json();
    for (const r of rows) {
      allScores.push({
        player_id: r.player_id,
        score_value: r.score_value,
        score_override: r.score_override,
        round_date: roundDateMap.get(r.league_round_id) ?? '',
      });
    }
  }
  return allScores;
}

/** All time reads season_standings — the view the All Time leaderboard reads — for the
 *  players on screen, in one request. Null on any failure, which leaves All time
 *  disabled rather than taking the season chart down with it. */
async function fetchCareerRows(groupId: string, playerIds: string[]): Promise<CareerRow[] | null> {
  const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
  const token = await getStoredAccessToken();
  const anonKey = getSupabaseAnonKey();
  if (!base || !token || playerIds.length === 0) return null;
  const headers = { Authorization: `Bearer ${token}`, apikey: anonKey || token };
  const inList = playerIds.map((id) => `"${id}"`).join(',');
  const res = await fetch(
    `${base}/rest/v1/season_standings?group_id=eq.${encodeURIComponent(groupId)}&player_id=in.(${inList})&select=season_id,player_id,rounds_played,total_points`,
    { headers },
  );
  if (!res.ok) return null;
  return res.json();
}

export function HistoryChart({ seasonId, groupId, standings, seasonStartDate, seasonEndDate, seasons }: Props) {
  const scheme = useColorScheme() ?? 'light';
  const c = Colors[scheme];
  const series = scheme === 'dark' ? CHART_SERIES_DARK : CHART_SERIES_LIGHT;

  const [chartState, setChartState] = useState<ChartData | null>(null);
  const [careerRows, setCareerRows] = useState<CareerRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [svgWidth, setSvgWidth] = useState(0);
  const [range, setRange] = useState<RangeKey>('season');

  // Selection, and the two independent pointer paths. `pinned` comes from a tap
  // (touch), `hovered` from a mouse. They are resolved, never merged.
  const [selected, setSelected] = useState<string[]>([]);
  const [pinned, setPinned] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [cursorY, setCursorY] = useState<number | null>(null);

  const todayIso = useMemo(() => isoOf(new Date()), []);
  // Where the Season chart's x=1 sits: today, or the season's last day once it has ended.
  const seasonAxis = seasonAxisEnd(seasonEndDate, todayIso);

  // All time's seasons: started by the chart's own local date, in start_date order.
  const spans = useMemo(() => careerSpans(seasons, todayIso), [seasons, todayIso]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // All time is only ever offered on the season in progress, so no other season
    // pays for its request.
    const onSeasonInProgress = spans.some((sp) => sp.toDate && sp.id === seasonId);
    Promise.all([
      fetchSeasonScores(seasonId, groupId),
      onSeasonInProgress
        ? fetchCareerRows(groupId, standings.map((r) => r.player_id)).catch(() => null)
        : Promise.resolve(null),
    ])
      .then(([scores, rows]) => {
        if (cancelled) return;
        const next = buildChartData(scores, standings, seasonStartDate, seasonAxis);
        setChartState(next);
        setCareerRows(rows);
        setSelected([]);
        setPinned(null);
        setHovered(null);
        // New data can take the active range off offer — a season switch lands on a
        // season with no recent rounds, or on one not in progress. Settle it in the same
        // batch, by the same rule the render uses, so a range off offer is never drawn.
        // Data only changes here and todayIso is fixed at mount.
        setRange(
          (prev) => historyModel({ season: next, careerRows: rows, spans, standings, seasonId, seasonEnd: seasonEndDate, todayIso, requested: prev }).range ?? 'season',
        );
      })
      .catch(() => {
        if (!cancelled) setChartState(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [seasonId, groupId, standings, seasonStartDate, seasonEndDate, seasonAxis, todayIso, spans]);

  // Every decision before drawing — the ranges on offer, the range to draw, the pills,
  // and whether there is anything to show at all — comes from historyModel, so
  // verify.js checks the decisions this renders (V-reach).
  const model = useMemo(
    () => (chartState ? historyModel({ season: chartState, careerRows, spans, standings, seasonId, seasonEnd: seasonEndDate, todayIso, requested: range }) : null),
    [chartState, careerRows, spans, standings, seasonId, seasonEndDate, todayIso, range],
  );

  // Everything the PLOT draws from, for the range on screen. Pills and hues do not
  // come from here: they read model.pills, so the player set and every player's
  // color hold still when the range changes.
  const view = useMemo((): RangeView | null => {
    if (!chartState || !model || model.range === null) return null;
    if (model.range === 'season') {
      const toX = makeToX(seasonStartDate, seasonAxis);
      return { data: chartState, toX, ticks: buildMonthTicks(seasonStartDate, seasonAxis, toX), dates: chartState.dates };
    }
    if (model.range === 'career') {
      if (!model.career) return null;
      const toX = careerToX(model.career.spans);
      return { data: model.career, toX, ticks: buildCareerTicks(model.career.spans, toX), dates: model.career.dates };
    }
    // Windows are only on offer for the season in progress, where seasonAxis is today.
    const days = RANGE_DAYS[model.range];
    const start = windowStartOf(todayIso, days);
    const data = windowChartData(chartState, start, todayIso);
    // One toX for the window's vertices AND its day ticks.
    const toX = makeToX(start, todayIso);
    return { data, toX, ticks: buildDayTicks(todayIso, days, toX), dates: data.dates };
  }, [chartState, model, seasonStartDate, seasonAxis, todayIso]);

  const onLayout = (e: LayoutChangeEvent) => setSvgWidth(e.nativeEvent.layout.width);

  if (loading) return <ActivityIndicator style={styles.spinner} size="large" />;

  // Not "no Season lines": in a season just begun nobody has one, and All time is then
  // the only thing worth showing. The model says when no range at all is on offer.
  if (!model || model.range === null || !view) {
    return <Text style={[styles.empty, { color: c.icon }]}>No history data.</Text>;
  }

  // The range's lines, in standings order. A pill whose player has no line in this
  // range simply highlights nothing here.
  const plottedLines = activeLinesOf(view.data);
  const { yMin, yMax } = view.data;
  const toX = view.toX;
  const snapDates = view.dates;
  const s = makeScales(svgWidth, yMin, yMax);
  const xTicks = view.ticks;
  const yTicks = niceTickValues(yMin, yMax, 6);

  // 10 days and 4 days show the change since windowStart. A player who did not play in
  // the window sits flat on 0: drawn extra-dim, under the baseline, and left out of the
  // automatic tooltip rows.
  const windowStart = model.range === 'd10' || model.range === 'd4' ? windowStartOf(todayIso, RANGE_DAYS[model.range]) : null;
  const resting = new Set<string>();
  if (windowStart !== null) {
    for (const l of plottedLines) if (!playedInWindow(l, windowStart, todayIso)) resting.add(l.id);
  }

  const allIds = model.pills.map((p) => p.id);
  const hues = assignHues(allIds, selected);
  const colorFor = (id: string) => {
    const slot = hues.get(id);
    return slot === undefined ? c.chartDim : series[slot];
  };

  // Pin beats hover: a mouse user who taps gets pin semantics, and a hover-only
  // user never sees a pin.
  const activeDate = pinned ?? hovered ?? null;
  const atCap = selected.length >= MAX_SELECTED;

  const togglePlayer = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((p) => p !== id);
      if (prev.length >= MAX_SELECTED) return prev;
      return [...prev, id];
    });
  };

  // A pin or hover is a position on the old x-axis and means nothing on the new
  // one. Selection is about players, not positions, so it stays.
  const changeRange = (next: RangeKey) => {
    setRange(next);
    setPinned(null);
    setHovered(null);
  };

  // --- Tooltip -------------------------------------------------------------
  // A View, not SVG: names need numberOfLines + ellipsis and values need
  // tabular-nums, neither of which react-native-svg's <Text> offers, and RN has
  // no text measurement to hand-lay-out SVG text against. The crosshair and the
  // dots stay in SVG.
  let tooltip: {
    header: string;
    rows: ReturnType<typeof buildTooltipRows>;
    left: number;
    top: number;
    height: number;
    cx: number;
  } | null = null;

  if (activeDate && svgWidth > 0) {
    const nx = toX(activeDate);
    // A tap gives an x, not a meaningful y, so the touch path ranks the nearest-5
    // from the plot's vertical midpoint.
    const cy = cursorY ?? PAD_T + s.plotH / 2;
    const career = model.range === 'career' ? model.career : null;
    const rows = career
      ? buildCareerTooltipRows(career, activeDate, selected, cy, s)
      : windowStart !== null
        ? buildWindowTooltipRows(view.data, windowStart, todayIso, nx, selected, cy, s)
        : buildTooltipRows(plottedLines, nx, selected, cy, s);
    if (rows.length > 0) {
      const height = TOOLTIP_PAD * 2 + TOOLTIP_HEADER_H + rows.length * TOOLTIP_ROW_H;
      const cx = s.toSvgX(nx);

      let left = cx + 10;
      if (left + TOOLTIP_W > svgWidth - PAD_R) left = cx - 10 - TOOLTIP_W;
      left = Math.max(PAD_L, Math.min(left, svgWidth - PAD_R - TOOLTIP_W));

      const positioned = rows.filter((r) => r.svgY !== null);
      const meanY = positioned.length
        ? positioned.reduce((a, r) => a + (r.svgY ?? 0), 0) / positioned.length
        : PAD_T + s.plotH / 2;
      const top = Math.max(PAD_T, Math.min(meanY - height / 2, CHART_H - PAD_B - height));

      // A bare date over a window's values would read as season totals.
      const header = career
        ? careerHeaderAt(career, activeDate)
        : windowStart !== null
          ? windowHeader(windowStart, activeDate)
          : formatFull(activeDate);
      tooltip = { header, rows, left, top, height, cx };
    }
  }

  // Both pointer paths snap to the range's own dates. makeToX clamps, so an
  // out-of-window date would otherwise land on the left edge and win the snap there.
  const handlePlotPress = (locationX: number) => {
    const d = nearestDate(snapDates, toX, s, locationX + PAD_L);
    setPinned((prev) => (prev === d ? null : d));
  };

  // Mouse path. currentTarget is the chartWrap element, so this x shares an
  // origin with svgWidth — deliberately NOT the plot-relative locationX the
  // Pressable hands back. Unifying the two is how an off-by-PAD_L gets in.
  const handleMouseMove = (e: any) => {
    const el = e?.currentTarget;
    if (!el?.getBoundingClientRect) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < PAD_L || x > (svgWidth || rect.width) - PAD_R) {
      setHovered(null);
      return;
    }
    setCursorY(y);
    setHovered(nearestDate(snapDates, toX, s, x));
  };

  const clearHover = () => {
    setHovered(null);
    setCursorY(null);
  };

  const webHoverProps =
    Platform.OS === 'web' ? ({ onMouseMove: handleMouseMove, onMouseLeave: clearHover } as object) : {};

  return (
    <Pressable style={styles.container} onPress={() => setPinned(null)}>
      {/* Range scopes the whole chart, so it sits above the player pills. Its own
          row, right-aligned under the Leaderboard / History toggle: below the pill
          row it would jump whenever the Clear pill changes the wrap. */}
      <View style={styles.rangeRow}>
        <SegmentedToggle
          options={model.options}
          value={model.range}
          onChange={changeRange}
        />
      </View>

      {/* Pills sit ABOVE the plot: a control belongs above what it controls, and
          it keeps the tap target in thumb reach instead of behind a 300px scroll. */}
      <View style={styles.pillRow}>
        {selected.length > 0 ? (
          <Pressable
            style={[styles.pill, { backgroundColor: c.card, borderColor: c.border }]}
            onPress={() => setSelected([])}
          >
            <Text style={[styles.pillLabel, { color: c.icon }]}>
              {'✕'} Clear ({selected.length}/{MAX_SELECTED})
            </Text>
          </Pressable>
        ) : null}

        {model.pills.map((line) => {
          const isSel = selected.includes(line.id);
          const hue = colorFor(line.id);
          // At the cap, unselected pills go genuinely disabled rather than
          // silently no-opping — a dead-looking tap is the worst of the options.
          const locked = atCap && !isSel;
          return (
            <Pressable
              key={line.id}
              disabled={locked}
              onPress={() => togglePlayer(line.id)}
              style={[
                styles.pill,
                {
                  backgroundColor: isSel ? hue + '1F' : c.card,
                  borderColor: isSel ? hue : c.border,
                },
              ]}
            >
              <View style={[styles.swatch, { backgroundColor: isSel ? hue : c.chartDim }]} />
              <Text
                numberOfLines={1}
                style={[
                  styles.pillLabel,
                  { color: isSel ? c.text : c.icon },
                  locked && styles.pillLabelLocked,
                ]}
              >
                {line.name}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* RN Web forwards onMouseMove/onMouseLeave to the DOM node (verified in
          react-native-web/dist/modules/forwardedProps/index.js:146,148), but RN's
          own ViewProps has no web pointer surface. Spread them untyped here
          rather than widening ViewProps app-wide, and only on web — there is no
          mouse to listen for on native. */}
      <View style={styles.chartWrap} onLayout={onLayout} {...webHoverProps}>
        {svgWidth > 0 && (
          <Svg width={svgWidth} height={CHART_H}>
            {yTicks.map((v) => {
              const y = s.toSvgY(v);
              if (y < PAD_T || y > CHART_H - PAD_B) return null;
              return (
                <SvgLine key={`yg-${v}`} x1={PAD_L} y1={y} x2={svgWidth - PAD_R} y2={y} stroke={c.border} strokeWidth={0.5} />
              );
            })}
            {yTicks.map((v) => {
              const y = s.toSvgY(v);
              if (y < PAD_T || y > CHART_H - PAD_B) return null;
              return (
                <SvgText key={`yl-${v}`} x={PAD_L - 6} y={y + 4} fontSize={11} fill={c.icon} textAnchor="end">
                  {String(v)}
                </SvgText>
              );
            })}

            {xTicks.map((tick, i) =>
              tick.grid === false ? null : (
                <SvgLine
                  key={`xg-${i}`}
                  x1={s.toSvgX(tick.nx)}
                  y1={PAD_T}
                  x2={s.toSvgX(tick.nx)}
                  y2={CHART_H - PAD_B}
                  stroke={c.border}
                  strokeWidth={0.5}
                />
              ),
            )}
            {xTicks.map((tick, i) =>
              tick.label ? (
                <SvgText
                  key={`xl-${i}`}
                  x={s.toSvgX(tick.nx)}
                  y={CHART_H - PAD_B + 14}
                  fontSize={11}
                  fill={c.icon}
                  textAnchor={tick.anchor ?? 'middle'}
                >
                  {tick.label}
                </SvgText>
              ) : null,
            )}

            {/* Season and All time: the zero line is chrome — dashed, under every line. */}
            {windowStart === null && yMin < 0 && yMax > 0 && (
              <SvgLine
                x1={PAD_L}
                y1={s.toSvgY(0)}
                x2={svgWidth - PAD_R}
                y2={s.toSvgY(0)}
                stroke={c.chartZero}
                strokeWidth={0.8}
                strokeDasharray="4,3"
              />
            )}

            {/* A window's players who did not play sit flat on 0, extra-dim, and are
                emitted BEFORE the baseline so it draws over them instead of vanishing
                under them. A selected one is not here: selection always wins. */}
            {plottedLines
              .filter((l) => resting.has(l.id) && !selected.includes(l.id))
              .map((line) => (
                <Polyline
                  key={`rest-${line.id}`}
                  points={polylinePoints(line, s)}
                  fill="none"
                  stroke={c.chartInactive}
                  strokeWidth={RESTING_STROKE}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}
            {/* In a window 0 is where every line started — above it is up over the
                window, below is down — so the zero line is the baseline: solid. */}
            {windowStart !== null && (
              <SvgLine
                x1={PAD_L}
                y1={s.toSvgY(0)}
                x2={svgWidth - PAD_R}
                y2={s.toSvgY(0)}
                stroke={c.chartZero}
                strokeWidth={BASELINE_STROKE}
              />
            )}

            {/* Two passes, not a sort and not an opacity trick: SVG paints in
                document order, so the dimmed field must be emitted first and the
                highlighted lines second to land on top of it. */}
            {plottedLines
              .filter((l) => !selected.includes(l.id) && !resting.has(l.id))
              .map((line) => (
                <Polyline
                  key={`dim-${line.id}`}
                  points={polylinePoints(line, s)}
                  fill="none"
                  stroke={c.chartDim}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}
            {plottedLines
              .filter((l) => selected.includes(l.id))
              .map((line) => (
                <Polyline
                  key={`sel-${line.id}`}
                  points={polylinePoints(line, s)}
                  fill="none"
                  stroke={colorFor(line.id)}
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}

            {tooltip ? (
              <>
                <SvgLine
                  x1={tooltip.cx}
                  y1={PAD_T}
                  x2={tooltip.cx}
                  y2={CHART_H - PAD_B}
                  stroke={c.chartZero}
                  strokeWidth={1}
                />
                {tooltip.rows.map((r) =>
                  r.svgY === null ? null : (
                    <Circle
                      key={`dot-${r.id}`}
                      cx={tooltip!.cx}
                      cy={r.svgY}
                      r={4}
                      fill={colorFor(r.id)}
                      stroke={c.card}
                      strokeWidth={1.5}
                    />
                  ),
                )}
              </>
            ) : null}
          </Svg>
        )}

        {/* Plot-rect tap target. Pressable rides RN Web's responder system, which
            leaves touch-action alone, so the enclosing ScrollView keeps its
            vertical scroll and a drag that starts here still scrolls the page. */}
        {svgWidth > 0 && (
          <Pressable
            style={[styles.plotHit, { left: PAD_L, right: PAD_R, top: PAD_T, bottom: PAD_B }]}
            onPress={(e) => handlePlotPress(e.nativeEvent.locationX)}
          />
        )}

        {tooltip ? (
          <View
            pointerEvents="none"
            style={[
              styles.tooltip,
              {
                left: tooltip.left,
                top: tooltip.top,
                width: TOOLTIP_W,
                backgroundColor: c.card,
                borderColor: c.border,
              },
            ]}
          >
            <Text style={[styles.tooltipHeader, { color: c.icon }]}>{tooltip.header}</Text>
            {tooltip.rows.map((r) => (
              <View key={r.id} style={styles.tooltipRow}>
                <View style={[styles.swatch, { backgroundColor: colorFor(r.id) }]} />
                <Text numberOfLines={1} style={[styles.tooltipName, { color: c.text }]}>
                  {r.name}
                </Text>
                {r.joined ? (
                  <Text style={[styles.tooltipEnded, { color: c.icon }]} numberOfLines={1}>
                    joined {r.joined}
                  </Text>
                ) : r.ended ? (
                  <Text style={[styles.tooltipEnded, { color: c.icon }]} numberOfLines={1}>
                    {Math.round(r.value)} · last {formatDay(r.lastDate!)}
                  </Text>
                ) : (
                  <Text style={[styles.tooltipValue, { color: c.text }]}>
                    {windowStart !== null ? formatSigned(r.value) : Math.round(r.value)}
                  </Text>
                )}
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 8 },
  spinner: { marginVertical: 40 },
  empty: { textAlign: 'center', marginTop: 24, fontSize: 15 },
  chartWrap: { height: CHART_H, marginTop: 8 },

  // The toggle's root is a row View, so without a row parent it would stretch to
  // full width. paddingRight 8 + the container's 8 puts its right edge on the
  // control bar's marginHorizontal 16, stacking it under the Leaderboard / History
  // toggle.
  rangeRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingRight: 8, marginBottom: 8 },

  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: 4 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 10,
    maxWidth: 140,
  },
  pillLabel: { fontSize: 12 },
  pillLabelLocked: { opacity: 0.5 },
  swatch: { width: 8, height: 8, borderRadius: 4 },

  plotHit: { position: 'absolute' },

  tooltip: {
    position: 'absolute',
    borderRadius: 8,
    borderWidth: 1,
    padding: TOOLTIP_PAD,
  },
  tooltipHeader: { fontSize: 11, height: TOOLTIP_HEADER_H, lineHeight: TOOLTIP_HEADER_H },
  tooltipRow: { flexDirection: 'row', alignItems: 'center', gap: 6, height: TOOLTIP_ROW_H },
  tooltipName: { flex: 1, fontSize: 12 },
  tooltipValue: { fontSize: 12, fontVariant: ['tabular-nums'] },
  tooltipEnded: { fontSize: 11, fontVariant: ['tabular-nums'] },
});
