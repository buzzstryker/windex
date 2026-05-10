/**
 * Read-only diagnostic for the season-rollover spec.
 *
 * For every group, fetches:
 *   - groups.season_start_month (the per-group schedule hint, populated by
 *     the retired Glide importer; never read by any other code)
 *   - The most recent season's start_date and end_date (highest end_date)
 *
 * Then reports whether the most-recent start_date's month matches
 * season_start_month. If any group is inconsistent, the rollover migration
 * needs the data fixed (or the spec adjusted) BEFORE we proceed — wrong
 * season_start_month doesn't break the rollover math (the helper extends
 * from previous end_date), but a mismatch hints that the importer's data
 * is stale and worth a human eyeball before we lock in cron.
 *
 * Also reports: count of seasons per group, pg_cron extension presence, and
 * whether pg_cron is reachable (sanity check before trying CREATE EXTENSION).
 *
 * Run from windex-api/:
 *   node scripts/check-season-start-months.mjs
 *
 * No writes. Safe to run anytime.
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: join(ROOT, '.env') });
} catch {}

const { createClient } = await import('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in windex-api/.env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function main() {
  // ── 1. Groups + season_start_month ───────────────────────────────────────
  const { data: groups, error: gErr } = await supabase
    .from('groups')
    .select('id, name, season_start_month')
    .order('name');
  if (gErr) throw gErr;

  // ── 2. All seasons (we'll bucket by group) ───────────────────────────────
  const { data: seasons, error: sErr } = await supabase
    .from('seasons')
    .select('id, group_id, start_date, end_date');
  if (sErr) throw sErr;

  const byGroup = new Map();
  for (const s of seasons) {
    const list = byGroup.get(s.group_id) ?? [];
    list.push(s);
    byGroup.set(s.group_id, list);
  }

  // ── 3. Per-group analysis ────────────────────────────────────────────────
  console.log('\n=== season_start_month vs most-recent-season start_date ===\n');
  console.log(
    'group_id                      ' +
    'name                                ' +
    'ssm  ' +
    'recent_start  recent_end    ' +
    'recent_month  match  count'
  );
  console.log('-'.repeat(140));

  let mismatches = 0;
  let zeroSchedule = 0;
  let noSeasons = 0;

  const sortedGroups = [...groups].sort((a, b) => a.name.localeCompare(b.name));
  for (const g of sortedGroups) {
    const list = byGroup.get(g.id) ?? [];
    list.sort((a, b) => b.end_date.localeCompare(a.end_date));
    const recent = list[0];
    const recentMonth = recent
      ? parseInt(recent.start_date.slice(5, 7), 10)
      : null;
    const ssm = g.season_start_month;
    let matchCol;
    if (!recent) {
      matchCol = '— no seasons';
      noSeasons++;
    } else if (ssm === 0) {
      matchCol = '— ssm=0 (skip)';
      zeroSchedule++;
    } else if (recentMonth === ssm) {
      matchCol = 'OK';
    } else {
      matchCol = `MISMATCH (recent=${MONTH_NAMES[recentMonth]} ssm=${MONTH_NAMES[ssm] ?? ssm})`;
      mismatches++;
    }

    console.log(
      g.id.padEnd(30) +
      (g.name ?? '').padEnd(36).slice(0, 36) +
      String(ssm).padStart(3) + '  ' +
      (recent?.start_date ?? '— —     ').padEnd(13) + '  ' +
      (recent?.end_date ?? '— —     ').padEnd(13) + '  ' +
      String(recentMonth ?? '—').padStart(13) + '  ' +
      matchCol.padEnd(7) + '  ' +
      String(list.length).padStart(5)
    );
  }

  console.log(`\nTotals: ${sortedGroups.length} groups, ${seasons.length} seasons.`);
  console.log(`  Mismatched (rollover would still extrapolate from end_date — flag for review): ${mismatches}`);
  console.log(`  ssm=0 (rollover SKIPS these groups per spec): ${zeroSchedule}`);
  console.log(`  No seasons yet (rollover SKIPS — bootstrap via Create Season UI): ${noSeasons}`);

  // ── 4. Compute what the rollover WOULD create ─────────────────────────────
  console.log('\n=== Rollover preview: what ensure_next_season_for_group() would create ===\n');
  console.log(
    'group_id                      name                                next_start    next_end      ' +
    'already_exists?'
  );
  console.log('-'.repeat(130));

  for (const g of sortedGroups) {
    const list = byGroup.get(g.id) ?? [];
    list.sort((a, b) => b.end_date.localeCompare(a.end_date));
    const recent = list[0];
    if (!recent) {
      console.log(g.id.padEnd(30) + (g.name ?? '').padEnd(36).slice(0, 36) + '— no seed season —');
      continue;
    }
    if (g.season_start_month === 0) {
      console.log(g.id.padEnd(30) + (g.name ?? '').padEnd(36).slice(0, 36) + '— ssm=0 —');
      continue;
    }
    // next_start = recent.end_date + 1 day
    const endDate = new Date(recent.end_date + 'T00:00:00Z');
    const nextStart = new Date(endDate.getTime());
    nextStart.setUTCDate(nextStart.getUTCDate() + 1);
    // next_end = next_start + 1 year - 1 day
    const nextEnd = new Date(nextStart.getTime());
    nextEnd.setUTCFullYear(nextEnd.getUTCFullYear() + 1);
    nextEnd.setUTCDate(nextEnd.getUTCDate() - 1);
    const fmt = (d) => d.toISOString().slice(0, 10);

    const already = list.some((s) => s.start_date === fmt(nextStart));

    console.log(
      g.id.padEnd(30) +
      (g.name ?? '').padEnd(36).slice(0, 36) +
      fmt(nextStart) + '    ' +
      fmt(nextEnd) + '    ' +
      (already ? 'YES (idempotent skip)' : 'no — would insert')
    );
  }

  // ── 5. pg_cron presence ──────────────────────────────────────────────────
  console.log('\n=== pg_cron extension status ===');
  // pg_extension is system-table, queryable via REST when service role is used
  const { data: ext, error: extErr } = await supabase
    .schema('pg_catalog')
    .from('pg_extension')
    .select('extname, extversion')
    .eq('extname', 'pg_cron');

  if (extErr) {
    console.log(`  Could not query pg_extension via REST (${extErr.message}). Won't be a blocker — CREATE EXTENSION IF NOT EXISTS in the migration is idempotent.`);
  } else if (ext.length === 0) {
    console.log('  pg_cron NOT yet installed. Migration will CREATE EXTENSION IF NOT EXISTS pg_cron.');
  } else {
    console.log(`  pg_cron INSTALLED (version ${ext[0].extversion}). CREATE EXTENSION IF NOT EXISTS is a no-op.`);
  }

  console.log('\nDone. Read-only — nothing was written.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
