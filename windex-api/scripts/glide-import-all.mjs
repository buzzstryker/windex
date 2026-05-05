/**
 * One-command Glide ODS import: sync structure, sync members, convert rounds, import rounds.
 *
 * Usage:
 *   node scripts/glide-import-all.mjs <path-to.ods> [--dry-run]
 *
 * Env (reads from .env automatically):
 *   SUPABASE_URL, SUPABASE_ANON_KEY
 *   GLIDE_IMPORT_EMAIL / GLIDE_IMPORT_PASSWORD  (or GLIDE_IMPORT_TOKEN)
 *
 * Steps:
 *   1. sync-glide-structure  — create sections, groups, seasons from ODS
 *   2. sync-glide-members    — create players, group_members, player_mappings from ODS
 *   3. convert rounds        — read ODS Rounds+Scores, write glide-import/rounds/*.json
 *      (auto-detects group_id and season_id from the ODS Groups/Seasons sheets)
 *   4. run-glide-import      — POST each round JSON to /ingest-event-results
 */
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const odsPath = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');

if (!odsPath) {
  console.error('Usage: node scripts/glide-import-all.mjs <path-to.ods> [--dry-run]');
  console.error('Example: node scripts/glide-import-all.mjs ../glide-export/610470.Late\\ Add\\ Golf.ods');
  process.exit(1);
}

if (!existsSync(odsPath)) {
  console.error('File not found:', odsPath);
  process.exit(1);
}

// Read ODS summary
const wb = XLSX.readFile(odsPath);
function readSheet(name) {
  const sheet = wb.Sheets[name];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}
const groups = readSheet('Groups').filter((r) => r['🔒 Row ID']);
const seasons = readSheet('Seasons').filter((r) => r['🔒 Row ID']);
const rounds = readSheet('Rounds').filter((r) => r['🔒 Row ID']);

console.log(`\nGlide import: ${odsPath}`);
console.log(`  Groups: ${groups.length}, Seasons: ${seasons.length}, Rounds: ${rounds.length}`);
console.log(`  Mode: multi-group (each round uses its own group + auto-matched season)`);
if (dryRun) console.log('  DRY RUN\n');
else console.log('');

const dryFlag = dryRun ? ['--dry-run'] : [];

function run(label, script, extraArgs = []) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`STEP: ${label}`);
  console.log('='.repeat(60));
  try {
    execFileSync('node', [join(ROOT, 'scripts', script), ...extraArgs], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env },
    });
  } catch (e) {
    console.error(`\nFAILED at step: ${label}`);
    process.exit(1);
  }
}

// Step 1: Sync structure
run('Sync structure (sections, groups, seasons)', 'sync-glide-structure.mjs', [odsPath, ...dryFlag]);

// Step 2: Sync members
run('Sync members (players, group_members, player_mappings)', 'sync-glide-members.mjs', [odsPath, ...dryFlag]);

// Step 3: Convert rounds to JSON (multi-group: no --group-id/--season-id, auto-matches per round)
run('Convert rounds to ingest payloads', 'convert-glide-ods-to-ingest.mjs', [odsPath]);

// Step 4: Import rounds
run('Import rounds via API', 'run-glide-import.mjs', [...dryFlag]);

console.log(`\n${'='.repeat(60)}`);
console.log('GLIDE IMPORT COMPLETE');
console.log('='.repeat(60));
