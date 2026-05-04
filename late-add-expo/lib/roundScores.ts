import { getStoredAccessToken } from '@/lib/api';
import { getApiBase, getSupabaseAnonKey } from '@/lib/config';

export type PlayerScore = {
  player_id: string;
  player_name: string;
  points: number;
};

export type RoundScores = Record<string, PlayerScore[]>;

export async function fetchRoundScores(roundIds: string[]): Promise<RoundScores> {
  const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
  const token = await getStoredAccessToken();
  const anonKey = getSupabaseAnonKey();
  if (!base || !token || roundIds.length === 0) return {};

  const headers = {
    Authorization: `Bearer ${token}`,
    apikey: anonKey || token,
  };

  const result: RoundScores = {};
  const BATCH = 100;

  for (let i = 0; i < roundIds.length; i += BATCH) {
    const batch = roundIds.slice(i, i + BATCH);
    const inList = batch.map((id) => `"${id}"`).join(',');
    try {
      const res = await fetch(
        `${base}/rest/v1/league_scores?league_round_id=in.(${inList})&select=league_round_id,player_id,score_value,score_override`,
        { headers }
      );
      if (!res.ok) continue;
      const scores: { league_round_id: string; player_id: string; score_value: number | null; score_override: number | null }[] = await res.json();
      for (const s of scores) {
        if (!result[s.league_round_id]) result[s.league_round_id] = [];
        result[s.league_round_id].push({
          player_id: s.player_id,
          player_name: s.player_id,
          points: Math.round(s.score_override ?? s.score_value ?? 0),
        });
      }
    } catch {
      // continue
    }
  }

  const allPlayerIds = new Set<string>();
  for (const scores of Object.values(result)) {
    for (const s of scores) allPlayerIds.add(s.player_id);
  }
  if (allPlayerIds.size > 0) {
    try {
      const idList = [...allPlayerIds].map((id) => `"${id}"`).join(',');
      const res = await fetch(
        `${base}/rest/v1/players?id=in.(${idList})&select=id,display_name`,
        { headers }
      );
      if (res.ok) {
        const players: { id: string; display_name: string }[] = await res.json();
        const nameMap = new Map(players.map((p) => [p.id, p.display_name]));
        for (const scores of Object.values(result)) {
          for (const s of scores) {
            s.player_name = nameMap.get(s.player_id) ?? s.player_id.slice(0, 8);
          }
        }
      }
    } catch {
      // keep player_id as name
    }
  }

  for (const scores of Object.values(result)) {
    scores.sort((a, b) => b.points - a.points);
  }

  return result;
}
