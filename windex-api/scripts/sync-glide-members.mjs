/**
 * Sync Glide UserProfiles → v2 players + group_members + player_mappings.
 * One v1 UserProfile row = one group_members row; same person (by email) = one player, multiple group_members.
 * Idempotent; supports multi-group (same player in multiple groups).
 *
 * Prereq: Run sync-glide-structure first so groups exist.
 * Usage: node scripts/sync-glide-members.mjs <path-to.ods> [--dry-run]
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, GLIDE_IMPORT_TOKEN or GLIDE_IMPORT_EMAIL/PASSWORD
 */
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: join(ROOT, '.env') });
} catch {}

const SOURCE_APP = 'glide';

function str(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

function normalizeEmail(email) {
  const s = str(email).toLowerCase();
  return s || null;
}

/** Deterministic id for group_members: safe for UNIQUE upsert */
function groupMemberId(groupId, playerId) {
  const safe = (x) => String(x).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  return `gm_${safe(groupId)}_${safe(playerId)}`;
}

async function getToken() {
  if (process.env.GLIDE_IMPORT_TOKEN) return process.env.GLIDE_IMPORT_TOKEN;
  const email = process.env.GLIDE_IMPORT_EMAIL || 'test@lateadd.local';
  const password = process.env.GLIDE_IMPORT_PASSWORD || 'testpass123';
  const { createClient } = await import('@supabase/supabase-js');
  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Sign-in failed: ${error.message}. Set GLIDE_IMPORT_TOKEN or GLIDE_IMPORT_EMAIL/GLIDE_IMPORT_PASSWORD.`);
  return data.session.access_token;
}

async function main() {
  const args = process.argv.slice(2);
  const odsPath = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');

  if (!odsPath) {
    console.error('Usage: node scripts/sync-glide-members.mjs <path-to.ods> [--dry-run]');
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

  const profiles = readSheet('UserProfiles');
  // v1 username = what is shown in Standings; v1 name = real name (profile only).
  const rawRows = profiles.filter((r) => r['🔒 Row ID']).map((r) => ({
    rowId: str(r['🔒 Row ID']),
    username: str(r['Identity/Username']),
    name: str(r['Identity/Name']),
    displayName: str(r['Identity/Username']) || str(r['Identity/Name']) || str(r['🔒 Row ID']),
    email: normalizeEmail(r['Identity/Email']),
    venmoHandle: str(r['Identity/Venmo Handle']),
    photoUrl: str(r['Identity/Photo']),
    role: str(r['Identity/Role']) || 'member',
    // Force active for all imported members so historical rounds can be ingested
    isActive: true,
    groupId: str(r['Group/ID']),
  }));

  if (rawRows.length === 0) {
    console.log('No UserProfile rows with 🔒 Row ID; nothing to sync.');
    return;
  }

  // Group by email to get canonical player_id per person; no email = one person per row
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

  // Canonical player_id: first rowId in each group (stable order)
  const rowIdToCanonical = new Map();
  const canonicalPlayers = new Map(); // canonicalId -> { display_name, full_name, email, venmo_handle, photo_url, is_active }

  for (const [email, rows] of emailToRows) {
    const first = rows[0];
    const canonicalId = first.rowId;
    for (const r of rows) rowIdToCanonical.set(r.rowId, canonicalId);
    const merged = {
      display_name: rows.map((r) => r.displayName).find(Boolean) || canonicalId,
      full_name: rows.map((r) => r.name).find(Boolean) || null,
      email: email,
      venmo_handle: rows.map((r) => r.venmoHandle).find(Boolean) || null,
      photo_url: rows.map((r) => r.photoUrl).find(Boolean) || null,
      is_active: rows.some((r) => r.isActive) ? 1 : 0,
    };
    canonicalPlayers.set(canonicalId, merged);
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

  const membershipRows = rawRows.map((r) => ({
    ...r,
    canonicalPlayerId: rowIdToCanonical.get(r.rowId),
  }));

  if (dryRun) {
    console.log('Dry run: would sync', canonicalPlayers.size, 'players and', membershipRows.length, 'group_members');
    console.log('Canonical player ids:', [...canonicalPlayers.keys()]);
    return;
  }

  const token = await getToken();
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user?.id) {
    throw new Error('Could not get current user: ' + (userErr?.message || 'not authenticated'));
  }
  const userId = userData.user.id;
  const now = new Date().toISOString();

  // Load existing group ids so we skip invalid Group/ID
  const { data: groupsData } = await supabase.from('groups').select('id');
  const validGroupIds = new Set((groupsData || []).map((g) => g.id));

  // 1. Upsert players (display_name = v1 username for standings parity; full_name = v1 name)
  for (const [canonicalId, attrs] of canonicalPlayers) {
    const { error } = await supabase.from('players').upsert(
      {
        id: canonicalId,
        user_id: userId,
        display_name: attrs.display_name,
        full_name: attrs.full_name ?? null,
        email: attrs.email,
        venmo_handle: attrs.venmo_handle,
        photo_url: attrs.photo_url,
        is_active: attrs.is_active,
        updated_at: now,
      },
      { onConflict: 'id,user_id', ignoreDuplicates: false }
    );
    if (error) {
      console.error('Player', canonicalId, error.message);
      continue;
    }
    console.log('Player', canonicalId, attrs.display_name);
  }

  // 2. Upsert group_members (skip if group_id not in v2)
  for (const row of membershipRows) {
    if (!validGroupIds.has(row.groupId)) {
      console.warn('Skip membership: group_id', row.groupId, 'not found in v2 (run sync-glide-structure first)');
      continue;
    }
    const gmId = groupMemberId(row.groupId, row.canonicalPlayerId);
    const { error } = await supabase.from('group_members').upsert(
      {
        id: gmId,
        group_id: row.groupId,
        player_id: row.canonicalPlayerId,
        role: row.role || 'member',
        is_active: row.isActive ? 1 : 0,
        joined_at: now,
      },
      { onConflict: 'group_id,player_id', ignoreDuplicates: false }
    );
    if (error) {
      console.error('Group member', row.groupId, row.canonicalPlayerId, error.message);
      continue;
    }
    console.log('Member', row.groupId, row.canonicalPlayerId, row.role);
  }

  // 3. Upsert player_mappings so round ingest resolves source_player_ref (Glide Row ID) → canonical player
  for (const row of rawRows) {
    const canonicalId = rowIdToCanonical.get(row.rowId);
    if (!canonicalId) continue;
    const { error } = await supabase.from('player_mappings').upsert(
      {
        user_id: userId,
        source_app: SOURCE_APP,
        source_player_ref: row.rowId,
        canonical_player_id: canonicalId,
        updated_at: now,
      },
      { onConflict: 'user_id,source_app,source_player_ref', ignoreDuplicates: false }
    );
    if (error) {
      console.error('Mapping', row.rowId, '->', canonicalId, error.message);
    }
  }

  console.log('Done. Players:', canonicalPlayers.size, '; memberships:', membershipRows.filter((r) => validGroupIds.has(r.groupId)).length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
