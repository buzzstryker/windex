import { useEffect, useState } from 'react';
import { ActivityIndicator, LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Svg, { Line as SvgLine, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { getApiBase, getSupabaseAnonKey } from '@/lib/config';
import { getStoredAccessToken, type StandingRow } from '@/lib/api';

const PLAYER_COLORS = [
  '#4B5E2A', '#2196F3', '#E91E63', '#FF9800', '#9C27B0',
  '#009688', '#F44336', '#3F51B5', '#8BC34A', '#FF5722',
  '#00BCD4', '#795548', '#607D8B', '#CDDC39', '#673AB7',
];

type Props = {
  seasonId: string;
  groupId: string;
  standings: StandingRow[];
  seasonStartDate: string;
  seasonEndDate: string;
};

type ScoreRow = {
  player_id: string;
  score_value: number | null;
  score_override: number | null;
  round_date: string;
};

type PlayerLine = {
  id: string;
  name: string;
  color: string;
  points: { x: number; y: number }[]; // normalized 0–1
};

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
    const rows: { player_id: string; score_value: number | null; score_override: number | null; league_round_id: string }[] = await res.json();
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

function buildLines(
  scores: ScoreRow[],
  standings: StandingRow[],
  seasonStart: string,
): { lines: PlayerLine[]; yMin: number; yMax: number; xMax: number } {
  const playerIds = standings.map((s) => s.player_id);

  // Group score deltas by date per player
  const deltasByDate = new Map<string, Map<string, number>>();
  for (const s of scores) {
    const pid = s.player_id;
    if (!playerIds.includes(pid)) continue;
    const pts = s.score_override ?? s.score_value ?? 0;
    const dateMap = deltasByDate.get(s.round_date) ?? new Map<string, number>();
    dateMap.set(pid, (dateMap.get(pid) ?? 0) + pts);
    deltasByDate.set(s.round_date, dateMap);
  }

  const sortedDates = [...deltasByDate.keys()].sort();
  const startTs = new Date(seasonStart + 'T00:00:00').getTime();
  const todayTs = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00').getTime();
  const range = todayTs - startTs || 1;

  // xMax = 1.0 represents today
  const toX = (date: string) => {
    const ts = new Date(date + 'T00:00:00').getTime();
    return Math.max(0, Math.min(1, (ts - startTs) / range));
  };

  let yMin = 0;
  let yMax = 0;

  const lines: PlayerLine[] = playerIds.map((pid, i) => {
    const points: { x: number; y: number }[] = [{ x: 0, y: 0 }];
    let cumulative = 0;

    for (const date of sortedDates) {
      const delta = deltasByDate.get(date)?.get(pid) ?? 0;
      if (delta !== 0) {
        cumulative += delta;
        points.push({ x: toX(date), y: cumulative });
      }
    }

    // If player has no rounds, return empty points (will be filtered out)
    if (points.length <= 1) {
      return {
        id: pid,
        name: standings[i]?.player_name ?? pid.slice(0, 8),
        color: PLAYER_COLORS[i % PLAYER_COLORS.length],
        points: [],
      };
    }

    for (const p of points) {
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }

    return {
      id: pid,
      name: standings[i]?.player_name ?? pid.slice(0, 8),
      color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      points,
    };
  });

  return { lines, yMin, yMax, xMax: 1 };
}

function niceTickValues(min: number, max: number, count: number): number[] {
  const range = max - min || 1;
  const roughStep = range / (count - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const options = [1, 2, 5, 10];
  let step = options[0] * magnitude;
  for (const o of options) {
    if (o * magnitude >= roughStep) { step = o * magnitude; break; }
  }
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.01; v += step) {
    ticks.push(Math.round(v));
  }
  return ticks;
}

export function HistoryChart({ seasonId, groupId, standings, seasonStartDate, seasonEndDate }: Props) {
  const [chartState, setChartState] = useState<{
    lines: PlayerLine[];
    yMin: number;
    yMax: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [svgWidth, setSvgWidth] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSeasonScores(seasonId, groupId)
      .then((scores) => {
        if (cancelled) return;
        setChartState(buildLines(scores, standings, seasonStartDate));
      })
      .catch(() => {
        if (!cancelled) setChartState(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [seasonId, groupId, standings, seasonStartDate, seasonEndDate]);

  const onLayout = (e: LayoutChangeEvent) => setSvgWidth(e.nativeEvent.layout.width);

  if (loading) return <ActivityIndicator style={styles.spinner} size="large" />;

  // Filter to players who have at least one round
  const activeLines = chartState?.lines.filter((l) => l.points.length > 0) ?? [];
  if (activeLines.length === 0) return <Text style={styles.empty}>No history data.</Text>;

  const { yMin: rawYMin, yMax: rawYMax } = chartState!;
  const pad = Math.max(10, Math.round((rawYMax - rawYMin) * 0.1));
  const yMin = rawYMin - pad;
  const yMax = rawYMax + pad;

  // Dynamic month ticks: count elapsed months from season start to today
  const startDate = new Date(seasonStartDate + 'T00:00:00');
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00');
  const elapsedMonths = Math.max(1,
    (today.getFullYear() - startDate.getFullYear()) * 12 +
    (today.getMonth() - startDate.getMonth())
  );

  // Build month tick labels: first letter of each month from season start
  const MONTH_LETTERS = ['J','F','M','A','M','J','J','A','S','O','N','D'];
  const monthTicks = Array.from({ length: elapsedMonths }, (_, i) => {
    const monthIndex = (startDate.getMonth() + 1 + i) % 12;
    return { nx: (i + 1) / (elapsedMonths + 1), label: MONTH_LETTERS[monthIndex] };
  });

  const CHART_H = 300;
  const PAD_L = 45;
  const PAD_R = 12;
  const PAD_T = 12;
  const PAD_B = 28;
  const plotW = Math.max(1, svgWidth - PAD_L - PAD_R);
  const plotH = CHART_H - PAD_T - PAD_B;

  const toSvgX = (nx: number) => PAD_L + nx * plotW;
  const toSvgY = (val: number) => PAD_T + (1 - (val - yMin) / (yMax - yMin)) * plotH;

  const yTicks = niceTickValues(yMin, yMax, 6);

  return (
    <View style={styles.container}>
      <View style={styles.chartWrap} onLayout={onLayout}>
        {svgWidth > 0 && (
          <Svg width={svgWidth} height={CHART_H}>
            {/* Y grid lines and labels */}
            {yTicks.map((v) => {
              const y = toSvgY(v);
              if (y < PAD_T || y > CHART_H - PAD_B) return null;
              return (
                <SvgLine key={`yg-${v}`} x1={PAD_L} y1={y} x2={svgWidth - PAD_R} y2={y} stroke="#E0E0E0" strokeWidth={0.5} />
              );
            })}
            {yTicks.map((v) => {
              const y = toSvgY(v);
              if (y < PAD_T || y > CHART_H - PAD_B) return null;
              return (
                <SvgText key={`yl-${v}`} x={PAD_L - 6} y={y + 4} fontSize={11} fill="#8E8E93" textAnchor="end">
                  {String(v)}
                </SvgText>
              );
            })}

            {/* X grid lines + month letter labels */}
            {monthTicks.map((tick, i) => {
              const x = toSvgX(tick.nx);
              return (
                <SvgLine key={`xg-${i}`} x1={x} y1={PAD_T} x2={x} y2={CHART_H - PAD_B} stroke="#E0E0E0" strokeWidth={0.5} />
              );
            })}
            {monthTicks.map((tick, i) => {
              const x = toSvgX(tick.nx);
              return (
                <SvgText key={`xl-${i}`} x={x} y={CHART_H - PAD_B + 14} fontSize={11} fill="#8E8E93" textAnchor="middle">
                  {tick.label}
                </SvgText>
              );
            })}

            {/* Zero line */}
            {yMin < 0 && yMax > 0 && (
              <SvgLine x1={PAD_L} y1={toSvgY(0)} x2={svgWidth - PAD_R} y2={toSvgY(0)} stroke="#999" strokeWidth={0.8} strokeDasharray="4,3" />
            )}

            {/* Player lines */}
            {activeLines.map((line) => {
              const pts = line.points.map((p) => `${toSvgX(p.x)},${toSvgY(p.y)}`).join(' ');
              return (
                <Polyline
                  key={line.id}
                  points={pts}
                  fill="none"
                  stroke={line.color}
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              );
            })}
          </Svg>
        )}
      </View>

      {/* Legend — only players with rounds */}
      <View style={styles.legend}>
        {activeLines.map((line) => (
          <View key={line.id} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: line.color }]} />
            <Text style={styles.legendLabel} numberOfLines={1}>{line.name}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 8 },
  spinner: { marginVertical: 40 },
  empty: { textAlign: 'center', marginTop: 24, fontSize: 15, color: '#8E8E93' },
  chartWrap: { height: 300, marginTop: 8 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 8, paddingTop: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendLabel: { fontSize: 12, color: '#666', maxWidth: 80 },
});
