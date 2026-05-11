import { getApiBase, getSupabaseAnonKey } from './config';

let getAccessToken: () => Promise<string | null> = async () => null;
let onUnauthorized: (() => void) | null = null;

export function setAccessTokenGetter(fn: () => Promise<string | null>) {
  getAccessToken = fn;
}

/** Register a callback invoked when the server returns 401 (expired/invalid JWT). */
export function setOnUnauthorized(fn: () => void) {
  onUnauthorized = fn;
}

/** Expose the stored token getter for direct REST calls. */
export function getStoredAccessToken(): Promise<string | null> {
  return getAccessToken();
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public path?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const base = getApiBase();
  if (!base) {
    throw new ApiError(0, 'Set EXPO_PUBLIC_LATE_ADD_API_URL or EXPO_PUBLIC_SUPABASE_URL in .env');
  }
  const token = await getAccessToken();
  if (!token) {
    throw new ApiError(401, 'Sign in first');
  }
  const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text) as { error?: string };
      if (j?.error) msg = j.error;
    } catch {
      /* keep text */
    }
    if (res.status === 401 && onUnauthorized) {
      onUnauthorized();
    }
    throw new ApiError(res.status, msg, path);
  }
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export type Group = {
  id: string;
  name: string;
  section_id?: string | null;
  logo_url?: string | null;
  dollars_per_point?: number | null;
};
export type Section = { id: string; name: string };

export type Season = {
  id: string;
  group_id: string;
  name: string | null;
  start_date: string;
  end_date: string;
  /** Manually-recorded Cup Champion (migration 025). NULL on current/future/legacy seasons. */
  cup_champion_player_id?: string | null;
  /** Optional free-text note explaining how the champion was decided (migration 025). */
  cup_champion_notes?: string | null;
};

export async function listGroups(): Promise<Group[]> {
  try {
    const data = await apiFetch<{ groups?: Group[] }>('/groups');
    return data.groups ?? [];
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return [];
    throw e;
  }
}

export async function listSections(): Promise<Section[]> {
  const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
  const token = await getAccessToken();
  if (!base || !token) return [];
  try {
    const anonKey = getSupabaseAnonKey();
    const res = await fetch(`${base}/rest/v1/sections?select=id,name&order=name`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: anonKey || token,
      },
    });
    if (!res.ok) return [];
    return (await res.json()) as Section[];
  } catch {
    return [];
  }
}

export async function getActiveMemberCount(groupId: string): Promise<number> {
  const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
  const token = await getAccessToken();
  if (!base || !token) return 0;
  try {
    const anonKey = getSupabaseAnonKey();
    const res = await fetch(
      `${base}/rest/v1/group_members?group_id=eq.${encodeURIComponent(groupId)}&is_active=eq.1&select=id`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: anonKey || token,
          Prefer: 'count=exact',
        },
      }
    );
    if (!res.ok) return 0;
    const count = res.headers.get('content-range');
    if (count) {
      const match = count.match(/\/(\d+)/);
      if (match) return parseInt(match[1], 10);
    }
    const data = await res.json();
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

export type GroupMember = {
  id: string;
  group_id: string;
  player_id: string;
  role: string;
  is_active: number;
};

export type PlayerDetail = {
  id: string;
  display_name: string;
  full_name: string | null;
  email: string | null;
  venmo_handle: string | null;
  is_active: number;
};

export type MemberWithPlayer = GroupMember & { player: PlayerDetail };

export async function listGroupMembers(groupId: string): Promise<MemberWithPlayer[]> {
  const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
  const token = await getAccessToken();
  if (!base || !token) return [];
  const anonKey = getSupabaseAnonKey();
  const headers = { Authorization: `Bearer ${token}`, apikey: anonKey || token };
  try {
    const [membersRes, playersRes] = await Promise.all([
      fetch(`${base}/rest/v1/group_members?group_id=eq.${encodeURIComponent(groupId)}&select=id,group_id,player_id,role,is_active`, { headers }),
      fetch(`${base}/rest/v1/players?select=id,display_name,full_name,email,venmo_handle,is_active`, { headers }),
    ]);
    if (!membersRes.ok || !playersRes.ok) return [];
    const members: GroupMember[] = await membersRes.json();
    const players: PlayerDetail[] = await playersRes.json();
    const playerMap = new Map(players.map((p) => [p.id, p]));
    return members
      .map((m) => {
        const p = playerMap.get(m.player_id);
        if (!p) return null;
        return { ...m, player: p };
      })
      .filter((x): x is MemberWithPlayer => x !== null)
      .sort((a, b) => a.player.display_name.localeCompare(b.player.display_name));
  } catch {
    return [];
  }
}

export async function updatePlayerRest(playerId: string, userId: string, updates: Record<string, unknown>): Promise<boolean> {
  const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
  const token = await getAccessToken();
  if (!base || !token) return false;
  const anonKey = getSupabaseAnonKey();
  const res = await fetch(
    `${base}/rest/v1/players?id=eq.${encodeURIComponent(playerId)}&user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: anonKey || token, Prefer: 'return=minimal' },
      body: JSON.stringify({ ...updates, updated_at: new Date().toISOString() }),
    }
  );
  return res.ok;
}

export async function updateMembershipRest(membershipId: string, updates: Record<string, unknown>): Promise<boolean> {
  const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
  const token = await getAccessToken();
  if (!base || !token) return false;
  const anonKey = getSupabaseAnonKey();
  const res = await fetch(
    `${base}/rest/v1/group_members?id=eq.${encodeURIComponent(membershipId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: anonKey || token, Prefer: 'return=minimal' },
      body: JSON.stringify(updates),
    }
  );
  return res.ok;
}

export type PlayerNames = {
  display_name: string;
  full_name: string | null;
};

/**
 * Resolve a set of player IDs to their display_name + full_name via
 * PostgREST. Returns a Map keyed by player_id. IDs that don't resolve
 * (deleted player, RLS blocks the row, etc.) are simply absent from the
 * map — callers should fall back to a placeholder like "—".
 *
 * Used by the GroupDetail screen to render the manually-recorded Cup
 * Champion AND the auto-computed Points Winner on each past-season card.
 * Both surfaces render `full_name`. Fire-and-forget on failure; returns
 * an empty map rather than throwing so a missing player never blocks the
 * rest of the page render.
 */
export async function getPlayerNames(playerIds: string[]): Promise<Map<string, PlayerNames>> {
  const unique = Array.from(new Set(playerIds.filter((id): id is string => !!id)));
  if (unique.length === 0) return new Map();
  const base = getApiBase().replace(/\/functions\/v1\/?$/, '');
  const token = await getAccessToken();
  if (!base || !token) return new Map();
  try {
    const anonKey = getSupabaseAnonKey();
    const inList = unique.map((id) => `"${id}"`).join(',');
    const res = await fetch(
      `${base}/rest/v1/players?id=in.(${inList})&select=id,display_name,full_name`,
      { headers: { Authorization: `Bearer ${token}`, apikey: anonKey || token } }
    );
    if (!res.ok) return new Map();
    const rows: { id: string; display_name: string; full_name: string | null }[] = await res.json();
    return new Map(rows.map((r) => [r.id, { display_name: r.display_name, full_name: r.full_name }]));
  } catch {
    return new Map();
  }
}

export async function listSeasons(groupId: string): Promise<Season[]> {
  try {
    const data = await apiFetch<{ seasons?: Season[] }>(
      `/seasons?group_id=${encodeURIComponent(groupId)}`
    );
    const all = data.seasons ?? [];
    // Hide future-dated seasons from the user-facing picker. The auto-rollover
    // job (migration 021) creates the next season ahead of time — sometimes
    // months early — so it sits dormant until its start_date arrives. Showing
    // it in the picker would let users select a season that hasn't started,
    // and would also trip GroupContext's auto-select fallback (which prefers
    // latest start_date when no current-as-of-today season is found).
    // windex-admin uses its own /seasons consumer (in src/api/groups.ts) and
    // intentionally keeps the unfiltered list so super admins can verify
    // newly-created future rows on GroupDetail.
    const today = new Date().toISOString().slice(0, 10);
    return all.filter((s) => !s.start_date || s.start_date <= today);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return [];
    throw e;
  }
}

export type StandingRow = {
  season_id: string;
  group_id: string;
  player_id: string;
  player_name?: string;
  rounds_played: number;
  wins: number;
  losses: number;
  ties: number;
  total_points: number;
  rank?: number;
};

export async function getStandings(seasonId: string, groupId?: string): Promise<StandingRow[]> {
  const params = new URLSearchParams({ season_id: seasonId });
  if (groupId) params.set('group_id', groupId);
  const data = await apiFetch<{ standings?: StandingRow[] }>(`/get-standings?${params}`);
  const list = data.standings ?? [];
  return list.map((row, i) => ({ ...row, rank: i + 1 }));
}

export type EventSummary = {
  id: string;
  external_event_id?: string | null;
  source_app?: string | null;
  round_date: string;
  group_id: string;
  group_name?: string;
  season_id?: string | null;
  season_name?: string | null;
  status: string;
  is_signature_event?: number;
  is_tournament?: number;
  tournament_buyin?: number | null;
};

export type EventDetail = {
  id: string;
  round_date: string;
  group_id: string;
  group_name?: string;
  season_id?: string | null;
  season_name?: string | null;
  status: string;
  is_signature_event?: number;
  is_tournament?: number;
  tournament_buyin?: number | null;
  results: EventResult[];
};

export type EventResult = {
  player_id: string;
  player_name?: string | null;
  score_value: number | null;
  score_override: number | null;
  game_points?: number | null;
  result_type?: string | null;
};

export type PlayerStandingsHistory = {
  player_id: string;
  player_name: string | null;
  total_points: number;
  rounds_played: number;
  history: {
    event_id: string;
    round_date: string;
    effective_points: number;
    score_value: number | null;
    score_override: number | null;
    source_app?: string;
  }[];
};

export async function listEvents(params: {
  group_id?: string;
  season_id?: string;
}): Promise<EventSummary[]> {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v) q.set(k, v); });
  const query = q.toString();
  try {
    const data = await apiFetch<{ events?: EventSummary[] }>(query ? `/events?${query}` : '/events');
    return data.events ?? [];
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return [];
    throw e;
  }
}

export async function getEvent(eventId: string): Promise<EventDetail> {
  return apiFetch<EventDetail>(`/events/${eventId}`);
}

export async function getPlayerHistory(
  groupId: string, seasonId: string, playerId: string
): Promise<PlayerStandingsHistory> {
  const params = new URLSearchParams({ group_id: groupId, season_id: seasonId, player_id: playerId });
  return apiFetch<PlayerStandingsHistory>(`/standings-player-history?${params}`);
}

export async function computeMoneyDeltas(leagueRoundId: string) {
  return apiFetch<{ league_round_id: string; computed: boolean; updated?: number; reason?: string }>(
    '/compute-money-deltas', { method: 'POST', body: JSON.stringify({ league_round_id: leagueRoundId }) }
  );
}

export async function generatePaymentRequests(leagueRoundId: string) {
  return apiFetch<{
    league_round_id: string;
    requests: { from_player_id: string; to_player_id: string; amount_cents: number }[];
  }>('/generate-payment-requests', { method: 'POST', body: JSON.stringify({ league_round_id: leagueRoundId }) });
}

export function seasonLabel(s: Season): string {
  if (s.name) return s.name;
  if (!s.start_date) return s.id.slice(0, 8);
  const start = new Date(s.start_date + 'T00:00:00');
  const end = s.end_date ? new Date(s.end_date + 'T00:00:00') : start;
  const mid = new Date((start.getTime() + end.getTime()) / 2);
  return String(mid.getFullYear());
}

/* --- Points Analysis --- */

export type PointsAnalysisResponse = {
  group_id: string;
  player_a: { id: string; display_name: string };
  player_b: { id: string; display_name: string };
  lifetime: {
    rounds_together: number;
    player_a_total_points: number;
    player_b_total_points: number;
    net_points: number;
    player_a_wins: number;
    player_b_wins: number;
    ties: number;
  };
  by_season: {
    season_id: string | null;
    season_name: string;
    rounds_together: number;
    player_a_total_points: number;
    player_b_total_points: number;
    net_points: number;
    player_a_wins: number;
    player_b_wins: number;
    ties: number;
    rounds: {
      league_round_id: string;
      round_date: string;
      player_a_points: number;
      player_b_points: number;
      net: number;
    }[];
  }[];
};

export async function getPointsAnalysis(
  groupId: string,
  playerAId: string,
  playerBId: string,
  seasonId?: string,
  excludeSigEvents = true
): Promise<PointsAnalysisResponse> {
  const params = new URLSearchParams({ group_id: groupId, player_a_id: playerAId, player_b_id: playerBId });
  if (seasonId) params.set('season_id', seasonId);
  params.set('exclude_signature_events', String(excludeSigEvents));
  return apiFetch<PointsAnalysisResponse>(`/get-points-analysis?${params}`);
}

/* --- Points Matrix --- */

export type PointsMatrixPlayer = { id: string; display_name: string };
export type PointsMatrixCell = { net: number; rounds: number };
export type PointsMatrixMatchup = { player_a: string; player_b: string; net: number; rounds: number; avg_per_round: number };

export type PointsMatrixResponse = {
  group_id: string;
  season_id: string | null;
  exclude_signature_events: boolean;
  players: PointsMatrixPlayer[];
  cells: Record<string, Record<string, PointsMatrixCell>>;
  matchups: PointsMatrixMatchup[];
};

export async function getPointsMatrix(groupId: string, seasonId?: string, excludeSigEvents = true): Promise<PointsMatrixResponse> {
  const params = new URLSearchParams({ group_id: groupId });
  if (seasonId) params.set('season_id', seasonId);
  params.set('exclude_signature_events', String(excludeSigEvents));
  return apiFetch<PointsMatrixResponse>(`/get-points-matrix?${params}`);
}
