/**
 * Generate a seed-bundle JSON from the Glide ODS export.
 *
 * Reads the ODS at ../glide-export/610470.Late Add Golf.ods and writes
 * ../windex-admin/src/data/glide-seed.json with sections, groups, seasons,
 * players, group_members, player_mappings, and rounds (ingest payloads).
 *
 * Usage: node scripts/generate-seed-bundle.mjs
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const ODS_PATH = join(ROOT, '..', 'glide-export', '610470.Late Add Golf.ods');
const OUT_DIR = join(ROOT, '..', 'windex-admin', 'src', 'data');
const OUT_PATH = join(OUT_DIR, 'glide-seed.json');

const SOURCE_APP = 'glide';

/* ── helpers ─────────────────────────────────────────────────────── */

function str(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

function toDateString(val) {
  if (!val) return '';
  if (typeof val === 'string' && val.includes('T')) return val.slice(0, 10);
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val);
    if (d) {
      const y = String(d.y).padStart(4, '0');
      const m = String(d.m).padStart(2, '0');
      const day = String(d.d).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
  }
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

function normalizeEmail(email) {
  const s = str(email).toLowerCase();
  return s || null;
}

function safePart(x) {
  return String(x).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

function groupMemberId(groupId, playerId) {
  return `gm_${safePart(groupId)}_${safePart(playerId)}`;
}

/* ── read workbook ───────────────────────────────────────────────── */

const wb = XLSX.readFile(ODS_PATH);

function readSheet(name) {
  const sheet = wb.Sheets[name];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

const sectionsRaw = readSheet('Sections');
const groupsRaw = readSheet('Groups');
const seasonsRaw = readSheet('Seasons');
const profilesRaw = readSheet('UserProfiles');
const roundsRaw = readSheet('Rounds');
const scoresRaw = readSheet('Scores');

/* ── sections ────────────────────────────────────────────────────── */

const sections = sectionsRaw
  .filter((r) => r['🔒 Row ID'])
  .map((r) => ({
    id: str(r['🔒 Row ID']),
    name: str(r['Section/Name']) || str(r['🔒 Row ID']),
  }));

/* ── groups ──────────────────────────────────────────────────────── */

const groups = groupsRaw
  .filter((r) => r['🔒 Row ID'])
  .map((r) => ({
    id: str(r['🔒 Row ID']),
    name: str(r['Group/Name']) || str(r['🔒 Row ID']),
    section_id: str(r['Section/ID']) || null,
    logo_url: str(r['Group/Logo']) || null,
    admin_player_id: str(r['Admin/ID']) || null,
    season_start_month: parseInt(str(r['Season/Start Month']), 10) || 1,
  }));

/* ── seasons (skip if missing start or end) ──────────────────────── */

const seasons = seasonsRaw
  .filter((r) => r['🔒 Row ID'])
  .map((r) => ({
    id: str(r['🔒 Row ID']),
    group_id: str(r['Group/ID']),
    start_date: toDateString(r['Season/Start Date']),
    end_date: toDateString(r['Season/End Date']),
  }))
  .filter((s) => s.start_date && s.end_date);

/* ── players, group_members, player_mappings (merge-by-email) ──── */

const rawRows = profilesRaw
  .filter((r) => r['🔒 Row ID'])
  .map((r) => ({
    rowId: str(r['🔒 Row ID']),
    username: str(r['Identity/Username']),
    name: str(r['Identity/Name']),
    displayName: str(r['Identity/Username']) || str(r['Identity/Name']) || str(r['🔒 Row ID']),
    email: normalizeEmail(r['Identity/Email']),
    venmoHandle: str(r['Identity/Venmo Handle']),
    photoUrl: str(r['Identity/Photo']),
    role: str(r['Identity/Role']) || 'member',
    isActive:
      r['Identity/Is Active'] === true ||
      str(r['Identity/Is Active']).toUpperCase() === 'TRUE',
    groupId: str(r['Group/ID']),
  }));

// Group by email for canonical player dedup
const emailToRows = new Map();
const noEmailRows = [];
for (const row of rawRows) {
  if (row.email) {
    if (!emailToRows.has(row.email)) emailToRows.set(row.email, []);
    emailToRows.get(row.email).push(row);
  } else {
    noEmailRows.push(row);
  }
}

const rowIdToCanonical = new Map();
const canonicalPlayers = new Map();

for (const [email, rows] of emailToRows) {
  const first = rows[0];
  const canonicalId = first.rowId;
  for (const r of rows) rowIdToCanonical.set(r.rowId, canonicalId);
  canonicalPlayers.set(canonicalId, {
    display_name: rows.map((r) => r.displayName).find(Boolean) || canonicalId,
    full_name: rows.map((r) => r.name).find(Boolean) || null,
    email,
    venmo_handle: rows.map((r) => r.venmoHandle).find(Boolean) || null,
    photo_url: rows.map((r) => r.photoUrl).find(Boolean) || null,
    is_active: rows.some((r) => r.isActive) ? 1 : 0,
  });
}

for (const row of noEmailRows) {
  rowIdToCanonical.set(row.rowId, row.rowId);
  canonicalPlayers.set(row.rowId, {
    display_name: row.displayName,
    full_name: row.name || null,
    email: null,
    venmo_handle: row.venmoHandle || null,
    photo_url: row.photoUrl || null,
    is_active: row.isActive ? 1 : 0,
  });
}

const players = [...canonicalPlayers.entries()].map(([id, attrs]) => ({
  id,
  display_name: attrs.display_name,
  full_name: attrs.full_name,
  email: attrs.email,
  venmo_handle: attrs.venmo_handle,
  photo_url: attrs.photo_url,
  is_active: attrs.is_active,
}));

// group_members: one per raw row (each profile row is a membership)
const gmSeen = new Set();
const group_members = [];
for (const row of rawRows) {
  const canonicalId = rowIdToCanonical.get(row.rowId);
  const gmId = groupMemberId(row.groupId, canonicalId);
  if (gmSeen.has(gmId)) continue; // deduplicate same group+player
  gmSeen.add(gmId);
  group_members.push({
    id: gmId,
    group_id: row.groupId,
    player_id: canonicalId,
    role: row.role || 'member',
    is_active: row.isActive ? 1 : 0,
  });
}

// player_mappings: one per raw row (each Glide rowId -> canonical player)
const player_mappings = rawRows.map((row) => ({
  source_app: SOURCE_APP,
  source_player_ref: row.rowId,
  canonical_player_id: rowIdToCanonical.get(row.rowId),
}));

/* ── rounds (ingest payloads) ────────────────────────────────────── */

const ROUNDS = roundsRaw
  .filter((r) => r['🔒 Row ID'])
  .map((r) => ({
    rowId: str(r['🔒 Row ID']),
    roundDate: toDateString(r['Round/Date']),
    submittedAt: toISOString(r['Round/Submitted At']) || null,
    groupId: str(r['Group/ID']),
    scoresOverride:
      r['Scores/Override'] === true ||
      str(r['Scores/Override']).toUpperCase() === 'TRUE',
  }));

const SCORES = scoresRaw
  .filter((r) => r['🔒 Row ID'])
  .map((r) => {
    const sv = r['Score/Value'];
    const so = r['Score/Score Override'];
    const points =
      so !== '' && so !== null && so !== undefined
        ? Number(so)
        : sv !== '' && sv !== null && sv !== undefined
          ? Number(sv)
          : null;
    return {
      roundId: str(r['Round/ID']),
      playerId: str(r['Player/ID']),
      points: points != null ? points : 0,
    };
  });

const profileByPlayerId = new Map(rawRows.map((p) => [p.rowId, p]));
const scoresByRoundId = new Map();
for (const s of SCORES) {
  if (!scoresByRoundId.has(s.roundId)) scoresByRoundId.set(s.roundId, []);
  scoresByRoundId.get(s.roundId).push(s);
}

// Season lookup by group, sorted newest-first
const seasonsByGroup = new Map();
for (const s of seasons) {
  if (!s.group_id || !s.start_date || !s.end_date) continue;
  if (!seasonsByGroup.has(s.group_id)) seasonsByGroup.set(s.group_id, []);
  seasonsByGroup.get(s.group_id).push(s);
}
for (const [, arr] of seasonsByGroup) {
  arr.sort((a, b) => b.start_date.localeCompare(a.start_date));
}

function findSeason(roundGroupId, roundDate) {
  const candidates = seasonsByGroup.get(roundGroupId) || [];
  for (const s of candidates) {
    if (roundDate >= s.start_date && roundDate <= s.end_date) return s.id;
  }
  return null;
}

const rounds = [];
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

  const roundGroupId = round.groupId;
  const roundSeasonId = findSeason(round.groupId, round.roundDate);

  const body = {
    group_id: roundGroupId,
    ...(roundSeasonId ? { season_id: roundSeasonId } : {}),
    round_date: round.roundDate,
    scores_override: round.scoresOverride || false,
    ...(round.submittedAt ? { submitted_at: round.submittedAt } : {}),
    source_app: SOURCE_APP,
    external_event_id: round.rowId,
    scores: ingestScores,
  };
  rounds.push(body);
}

/* ── write output ────────────────────────────────────────────────── */

mkdirSync(OUT_DIR, { recursive: true });

const bundle = {
  sections,
  groups,
  seasons,
  players,
  group_members,
  player_mappings,
  rounds,
};

writeFileSync(OUT_PATH, JSON.stringify(bundle, null, 2), 'utf-8');

/* ── summary ─────────────────────────────────────────────────────── */

console.log(`Wrote ${OUT_PATH}`);
console.log(`  sections:        ${sections.length}`);
console.log(`  groups:          ${groups.length}`);
console.log(`  seasons:         ${seasons.length}`);
console.log(`  players:         ${players.length}`);
console.log(`  group_members:   ${group_members.length}`);
console.log(`  player_mappings: ${player_mappings.length}`);
console.log(`  rounds:          ${rounds.length}`);
