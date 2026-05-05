/**
 * POST each round from glide-import/ to Windex ingest-event-results.
 *
 * Prereqs:
 *   1. Run: npm run glide:convert path/to/file.ods --group-id=<id> --season-id=<id>
 *   2. Create group and season in Windex (or use seed group-seed-001, season-seed-001)
 *   3. Set env: SUPABASE_URL, GLIDE_IMPORT_TOKEN (Bearer JWT) or use test user sign-in
 *
 * Usage: node scripts/run-glide-import.mjs [--dry-run]
 */
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: join(ROOT, '.env') });
} catch {}

const BASE = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const FUNCTIONS = `${BASE}/functions/v1`;
const dryRun = process.argv.includes('--dry-run');

async function getToken() {
  if (process.env.GLIDE_IMPORT_TOKEN) return process.env.GLIDE_IMPORT_TOKEN;
  const email = process.env.GLIDE_IMPORT_EMAIL || 'test@lateadd.local';
  const password = process.env.GLIDE_IMPORT_PASSWORD || 'testpass123';
  const { createClient } = await import('@supabase/supabase-js');
  const anon = createClient(BASE, process.env.SUPABASE_ANON_KEY);
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Sign-in failed: ${error.message}. Set GLIDE_IMPORT_TOKEN or GLIDE_IMPORT_EMAIL/GLIDE_IMPORT_PASSWORD.`);
  return data.session.access_token;
}

async function main() {
  const manifestPath = join(ROOT, 'glide-import', 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    console.error('Run glide:convert first to create glide-import/manifest.json');
    process.exit(1);
  }
  const rounds = manifest.rounds || [];
  if (rounds.length === 0) {
    console.log('No rounds in manifest.');
    return;
  }
  const token = await getToken();
  let ok = 0;
  let err = 0;
  for (const r of rounds) {
    const path = join(ROOT, 'glide-import', r.file);
    const body = JSON.parse(readFileSync(path, 'utf-8'));
    if (dryRun) {
      console.log(`[dry-run] POST ${r.round_date} ${r.playerCount} players`);
      ok++;
      continue;
    }
    const res = await fetch(`${FUNCTIONS}/ingest-event-results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 200 || res.status === 201) {
      console.log(`OK ${r.round_date} -> league_round_id ${data.league_round_id || data.id}`);
      ok++;
    } else {
      console.error(`FAIL ${r.round_date} ${res.status}`, data.error || data);
      err++;
    }
  }
  console.log(`Done: ${ok} ok, ${err} failed`);
  if (err) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
