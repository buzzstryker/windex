/**
 * Convert a Glide ODS export into Windex ingest-event-results payloads.
 *
 * Usage:
 *   node scripts/convert-glide-ods-to-ingest.mjs <path-to.ods> --group-id=<LATE_ADD_GROUP_ID> --season-id=<LATE_ADD_SEASON_ID>
 *
 * Output: glide-import/rounds/*.json (one per round) and glide-import/manifest.json
 * Each round file is a full POST body for /ingest-event-results. Uses source_app "glide"
 * and source_player_ref/source_player_name so unresolved players go to player_mapping_queue.
 *
 * Requires: group_id and season_id from your Windex instance (create group/season first).
 */
import { writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function str(val) {
  if (val === null || val === undefined) return '';
  return String(val);
}

function toISOString(val) {
  if (!val) return '';
  if (typeof val === 'string' && val.includes('T')) return val;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val);
    if (d) {
      const dt = new Date(Date.UTC(d.y, d.m - 1, d.d, d.H || 0, d.M || 0, d.S || 0));
      return dt.toISOString();
    }
  }
  return String(val);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const odsPath = args.find((a) => !a.startsWith('--'));
  let groupId = null;
  let seasonId = null;
  for (const a of args) {
    if (a.startsWith('--group-id=')) groupId = a.slice('--group-id='.length).trim();
    if (a.startsWith('--season-id=')) seasonId = a.slice('--season-id='.length).trim();
  }
  return { odsPath, groupId, seasonId };
}

function main() {
  const { odsPath, groupId, seasonId } = parseArgs();
  if (!odsPath) {
    console.error('Usage: node scripts/convert-glide-ods-to-ingest.mjs <path-to.ods> --group-id=<id> --season-id=<id>');
    console.error('Example: node scripts/convert-glide-ods-to-ingest.mjs glide-export/f35a60.Late Add Golf.ods --group-id=group-seed-001 --season-id=season-seed-001');
    process.exit(1);
  }

  if (!existsSync(odsPath)) {
    console.error('File not found:', odsPath);
    process.exit(1);
  }

  const wb = XLSX.readFile(odsPath);
  function readSheet(name) {
    const sheet = wb.Sheets[name];
    if (!sheet) return [];
    return XLSX.utils.sheet_to_json(sheet, { defval: '' });
  }

  const sections = readSheet('Sections');
  const groups = readSheet('Groups');
  const profiles = readSheet('UserProfiles');
  const seasons = readSheet('Seasons');
  const rounds = readSheet('Rounds');
  const scores = readSheet('Scores');

  const GROUPS = groups.filter((r) => r['🔒 Row ID']).map((r) => ({
    rowId: str(r['🔒 Row ID']),
    groupId: str(r['🔒 Row ID']),
  }));
  // v1 username = shown in Standings; use for source_player_name so v2 matches v1 display.
  const PROFILES = profiles.filter((r) => r['🔒 Row ID']).map((r) => ({
    rowId: str(r['🔒 Row ID']),
    username: str(r['Identity/Username']),
    name: str(r['Identity/Name']),
    displayName: str(r['Identity/Username']) || str(r['Identity/Name']) || r.rowId,
    email: str(r['Identity/Email']),
    venmoHandle: str(r['Identity/Venmo Handle']),
    role: str(r['Identity/Role']),
    isActive: r['Identity/Is Active'] === true || str(r['Identity/Is Active']).toUpperCase() === 'TRUE',
    photoUrl: str(r['Identity/Photo']),
    groupId: str(r['Group/ID']),
  }));
  const SEASONS = seasons.filter((r) => r['🔒 Row ID']).map((r) => ({
    rowId: str(r['🔒 Row ID']),
    startDate: toISOString(r['Season/Start Date']).slice(0, 10),
    endDate: toISOString(r['Season/End Date']).slice(0, 10),
    groupId: str(r['Group/ID']),
  }));
  const ROUNDS = rounds.filter((r) => r['🔒 Row ID']).map((r) => ({
    rowId: str(r['🔒 Row ID']),
    roundDate: toISOString(r['Round/Date']).slice(0, 10),
    submittedAt: toISOString(r['Round/Submitted At']) || null,
    groupId: str(r['Group/ID']),
    scoresOverride: r['Scores/Override'] === true || str(r['Scores/Override']).toUpperCase() === 'TRUE',
  }));
  // Parse raw scores, keeping override and value separate for head-to-head computation.
  const RAW_SCORES = scores.filter((r) => r['🔒 Row ID']).map((r) => {
    const sv = r['Score/Value'];
    const so = r['Score/Score Override'];
    const hasOverride = so !== '' && so !== null && so !== undefined;
    const hasValue = sv !== '' && sv !== null && sv !== undefined;
    return {
      roundId: str(r['Round/ID']),
      playerId: str(r['Player/ID']),
      override: hasOverride ? Number(so) : null,
      value: hasValue ? Number(sv) : null,
    };
  });

  // Group by round for head-to-head computation
  const rawByRoundId = new Map();
  for (const s of RAW_SCORES) {
    if (!rawByRoundId.has(s.roundId)) rawByRoundId.set(s.roundId, []);
    rawByRoundId.get(s.roundId).push(s);
  }

  // Compute standing points per score:
  // - If Score/Score Override is present, use it directly (already computed).
  // - If only Score/Value is present, apply head-to-head formula:
  //   standing_points = N * player_score - round_total
  //   (equivalent to sum of (player_score - opponent_score) for each opponent)
  const scoresByRoundId = new Map();
  for (const [roundId, rawScores] of rawByRoundId) {
    const allHaveOverride = rawScores.every((s) => s.override !== null);
    const noneHaveOverride = rawScores.every((s) => s.override === null);

    let resolved;
    if (allHaveOverride) {
      // All pre-computed: use override directly
      resolved = rawScores.map((s) => ({ roundId: s.roundId, playerId: s.playerId, points: s.override }));
    } else if (noneHaveOverride) {
      // All raw game points: compute head-to-head
      const N = rawScores.length;
      const roundTotal = rawScores.reduce((sum, s) => sum + (s.value ?? 0), 0);
      resolved = rawScores.map((s) => ({
        roundId: s.roundId,
        playerId: s.playerId,
        points: N * (s.value ?? 0) - roundTotal,
      }));
    } else {
      // Mixed: use override when present, value as-is when not (best effort)
      resolved = rawScores.map((s) => ({
        roundId: s.roundId,
        playerId: s.playerId,
        points: s.override ?? s.value ?? 0,
      }));
    }
    scoresByRoundId.set(roundId, resolved);
  }

  const profileByPlayerId = new Map(PROFILES.map((p) => [p.rowId, p]));

  // Build season lookup: for each group, sorted by start_date desc so newest season matches first
  const seasonsByGroup = new Map();
  for (const s of SEASONS) {
    if (!s.groupId || !s.startDate || !s.endDate) continue;
    if (!seasonsByGroup.has(s.groupId)) seasonsByGroup.set(s.groupId, []);
    seasonsByGroup.get(s.groupId).push(s);
  }
  for (const [, arr] of seasonsByGroup) arr.sort((a, b) => b.startDate.localeCompare(a.startDate));

  function findSeason(roundGroupId, roundDate) {
    // If CLI overrides are set, use them
    if (groupId && seasonId) return seasonId;
    const candidates = seasonsByGroup.get(roundGroupId) || [];
    for (const s of candidates) {
      if (roundDate >= s.startDate && roundDate <= s.endDate) return s.rowId;
    }
    // No matching season — return null (will be ingested with pending attribution)
    return null;
  }

  const outDir = join(ROOT, 'glide-import', 'rounds');
  mkdirSync(outDir, { recursive: true });

  const manifest = { source: odsPath.split(/[/\\]/).pop(), mode: (groupId && seasonId) ? 'single' : 'multi-group', rounds: [] };
  let count = 0;
  let noSeason = 0;

  for (const round of ROUNDS) {
    const roundScores = scoresByRoundId.get(round.rowId) || [];
    const ingestScores = roundScores.map((s) => {
      const profile = profileByPlayerId.get(s.playerId);
      const base = {
        source_player_ref: s.playerId,
        source_player_name: profile ? profile.displayName : s.playerId,
        score_value: s.points,
      };
      if (!profile) return base;
      const out = { ...base };
      if (profile.email) out.source_email = profile.email;
      if (profile.venmoHandle) out.source_venmo_handle = profile.venmoHandle;
      if (profile.photoUrl) out.source_photo_url = profile.photoUrl;
      if (profile.role) out.source_role = profile.role;
      out.source_is_active = profile.isActive;
      return out;
    });
    if (ingestScores.length === 0) continue;

    const roundGroupId = groupId || round.groupId;
    const roundSeasonId = findSeason(round.groupId, round.roundDate);
    if (!roundSeasonId) noSeason++;

    const body = {
      group_id: roundGroupId,
      ...(roundSeasonId ? { season_id: roundSeasonId } : {}),
      round_date: round.roundDate,
      scores_override: round.scoresOverride || false,
      ...(round.submittedAt ? { submitted_at: round.submittedAt } : {}),
      source_app: 'glide',
      external_event_id: round.rowId,
      scores: ingestScores,
    };
    const safeId = round.rowId.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 40);
    const path = join(outDir, `round_${safeId}.json`);
    writeFileSync(path, JSON.stringify(body, null, 2), 'utf-8');
    manifest.rounds.push({ roundId: round.rowId, round_date: round.roundDate, group_id: roundGroupId, season_id: roundSeasonId || null, file: `rounds/round_${safeId}.json`, playerCount: ingestScores.length });
    count++;
  }

  writeFileSync(join(ROOT, 'glide-import', 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`Wrote ${count} round(s) to glide-import/rounds/ and glide-import/manifest.json`);
  if (noSeason > 0) console.log(`  ${noSeason} round(s) had no matching season (will use pending attribution).`);
  console.log('Run: npm run glide:import  (with SUPABASE_URL, SUPABASE_ANON_KEY, and auth token) to POST each round to ingest-event-results.');
}

main();
