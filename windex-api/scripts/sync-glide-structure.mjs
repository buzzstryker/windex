/**
 * Sync Glide ODS structure (Sections, Groups, Seasons) into Windex.
 * Creates or updates sections, groups, and seasons so Glide Section/Name,
 * Group/Name, Group/Logo, Season/Start Date, etc. all have a place.
 *
 * After this, run glide:convert with --group-id=<Glide Group Row ID> and
 * --season-id=<Glide Season Row ID> (use the IDs from the Glide export).
 *
 * Usage: node scripts/sync-glide-structure.mjs <path-to.ods> [--dry-run]
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, GLIDE_IMPORT_TOKEN or GLIDE_IMPORT_EMAIL/PASSWORD
 */
import { readFileSync, existsSync } from 'fs';
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
    console.error('Usage: node scripts/sync-glide-structure.mjs <path-to.ods> [--dry-run]');
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
  const seasons = readSheet('Seasons');

  const SECTIONS = sections.filter((r) => r['🔒 Row ID']).map((r) => ({
    id: str(r['🔒 Row ID']),
    name: str(r['Section/Name']) || str(r['🔒 Row ID']),
  }));

  const GROUPS = groups.filter((r) => r['🔒 Row ID']).map((r) => ({
    id: str(r['🔒 Row ID']),
    name: str(r['Group/Name']) || str(r['🔒 Row ID']),
    section_id: str(r['Section/ID']) || null,
    logo_url: str(r['Group/Logo']) || null,
    admin_player_id: str(r['Admin/ID']) || null,
    season_start_month: parseInt(str(r['Season/Start Month']), 10) || 1,
  }));

  const SEASONS = seasons.filter((r) => r['🔒 Row ID']).map((r) => ({
    id: str(r['🔒 Row ID']),
    group_id: str(r['Group/ID']),
    start_date: toISOString(r['Season/Start Date']).slice(0, 10) || '',
    end_date: toISOString(r['Season/End Date']).slice(0, 10) || '',
  }));

  if (dryRun) {
    console.log('Dry run: would create/update', SECTIONS.length, 'sections,', GROUPS.length, 'groups,', SEASONS.length, 'seasons');
    console.log('Section IDs:', SECTIONS.map((s) => s.id));
    console.log('Group IDs:', GROUPS.map((g) => g.id));
    console.log('Season IDs:', SEASONS.map((s) => s.id));
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

  for (const s of SECTIONS) {
    const { error } = await supabase.from('sections').upsert(
      { id: s.id, user_id: userId, name: s.name, updated_at: now },
      { onConflict: 'id', ignoreDuplicates: false }
    );
    if (error) {
      console.error('Section', s.id, error.message);
      continue;
    }
    console.log('Section', s.id, s.name);
  }

  for (const g of GROUPS) {
    const row = {
      id: g.id,
      user_id: userId,
      name: g.name,
      section_id: g.section_id || null,
      logo_url: g.logo_url || null,
      admin_player_id: g.admin_player_id || null,
      season_start_month: g.season_start_month,
      updated_at: now,
    };
    const { error } = await supabase.from('groups').upsert(row, { onConflict: 'id', ignoreDuplicates: false });
    if (error) {
      console.error('Group', g.id, error.message);
      continue;
    }
    console.log('Group', g.id, g.name);
  }

  for (const s of SEASONS) {
    if (!s.start_date || !s.end_date) {
      console.warn('Season', s.id, 'skipped: missing start_date or end_date');
      continue;
    }
    const { error } = await supabase.from('seasons').upsert(
      { id: s.id, group_id: s.group_id, start_date: s.start_date, end_date: s.end_date, updated_at: now },
      { onConflict: 'id', ignoreDuplicates: false }
    );
    if (error) {
      console.error('Season', s.id, error.message);
      continue;
    }
    console.log('Season', s.id, s.group_id, s.start_date, '-', s.end_date);
  }

  console.log('Done. Use --group-id and --season-id from the IDs above when running glide:convert.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
