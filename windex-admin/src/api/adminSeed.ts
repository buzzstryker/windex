import { apiFetch, getAuthToken } from './client';
import seedData from '../data/glide-seed.json';

const SUPABASE_URL = (
  typeof import.meta.env !== 'undefined' && import.meta.env.VITE_LATE_ADD_API_URL
    ? import.meta.env.VITE_LATE_ADD_API_URL
    : 'https://ftmqzxykwcccocogkjhc.supabase.co/functions/v1'
).replace(/\/functions\/v1\/?$/, '');

const ANON_KEY =
  typeof import.meta.env !== 'undefined' && import.meta.env.VITE_SUPABASE_ANON_KEY
    ? import.meta.env.VITE_SUPABASE_ANON_KEY
    : null;

/** POST to PostgREST to upsert rows (uses JWT + RLS) */
async function postRest(table: string, rows: Record<string, unknown>[]) {
  const token = getAuthToken() ?? ANON_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(ANON_KEY ? { apikey: ANON_KEY } : {}),
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /rest/v1/${table} ${res.status}: ${text}`);
  }
}

export type SeedProgress = {
  step: string;
  done: boolean;
  roundsOk?: number;
  roundsFailed?: number;
};

/** Extract user_id from the JWT */
function getCurrentUserId(): string {
  const token = getAuthToken();
  if (!token) throw new Error('No auth token — sign in first');
  const payload = JSON.parse(atob(token.split('.')[1]));
  return payload.sub;
}

export async function resetAndSeed(
  onProgress: (p: SeedProgress) => void
): Promise<void> {
  const userId = getCurrentUserId();

  // Step 1: Clear all data
  onProgress({ step: 'Clearing all data...', done: false });
  await apiFetch<{ ok: boolean }>('/admin-reset', { method: 'POST' });

  // Step 2: Insert structure
  onProgress({ step: 'Syncing sections...', done: false });
  await postRest('sections', seedData.sections.map((s) => ({ ...s, user_id: userId })));

  onProgress({ step: 'Syncing groups...', done: false });
  await postRest('groups', seedData.groups.map((g) => ({ ...g, user_id: userId })));

  onProgress({ step: 'Syncing seasons...', done: false });
  await postRest('seasons', seedData.seasons);

  // Step 3: Insert members
  onProgress({ step: 'Syncing players...', done: false });
  await postRest('players', seedData.players.map((p) => ({ ...p, user_id: userId })));

  onProgress({ step: 'Syncing group members...', done: false });
  await postRest('group_members', seedData.group_members);

  onProgress({ step: 'Syncing player mappings...', done: false });
  await postRest('player_mappings', seedData.player_mappings.map((m) => ({ ...m, user_id: userId })));

  // Step 4: Ingest rounds (10 concurrent requests for speed)
  const total = seedData.rounds.length;
  let ok = 0;
  let failed = 0;
  const BATCH = 10;
  for (let i = 0; i < total; i += BATCH) {
    const batch = seedData.rounds.slice(i, i + BATCH);
    onProgress({ step: `Importing rounds... ${i + 1}/${total}`, done: false, roundsOk: ok, roundsFailed: failed });
    const results = await Promise.allSettled(
      batch.map((round) =>
        apiFetch('/ingest-event-results', { method: 'POST', body: JSON.stringify(round) })
      )
    );
    for (const r of results) {
      if (r.status === 'fulfilled') ok++;
      else failed++;
    }
  }

  onProgress({ step: `Done! ${ok} rounds imported, ${failed} failed.`, done: true, roundsOk: ok, roundsFailed: failed });
}

/**
 * Import only new rounds that don't already exist in the database.
 * Fetches existing external_event_ids, filters the seed rounds, and POSTs only new ones.
 * Also upserts structure + members to catch any new additions.
 */
export async function importNewRounds(
  onProgress: (p: SeedProgress) => void
): Promise<void> {
  const userId = getCurrentUserId();

  // Upsert structure + members (fast, idempotent)
  onProgress({ step: 'Syncing structure & members...', done: false });
  await postRest('sections', seedData.sections.map((s) => ({ ...s, user_id: userId })));
  await postRest('groups', seedData.groups.map((g) => ({ ...g, user_id: userId })));
  await postRest('seasons', seedData.seasons);
  await postRest('players', seedData.players.map((p) => ({ ...p, user_id: userId })));
  await postRest('group_members', seedData.group_members);
  await postRest('player_mappings', seedData.player_mappings.map((m) => ({ ...m, user_id: userId })));

  // Fetch existing external_event_ids
  onProgress({ step: 'Checking existing rounds...', done: false });
  const token = getAuthToken() ?? ANON_KEY;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/league_rounds?select=external_event_id&source_app=eq.glide&external_event_id=not.is.null`,
    {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(ANON_KEY ? { apikey: ANON_KEY } : {}),
      },
    }
  );
  const existing: { external_event_id: string }[] = res.ok ? await res.json() : [];
  const existingIds = new Set(existing.map((r) => r.external_event_id));

  // Filter to only new rounds
  type Round = (typeof seedData.rounds)[number];
  const newRounds = seedData.rounds.filter(
    (r: Round) => !existingIds.has((r as Record<string, unknown>).external_event_id as string)
  );

  if (newRounds.length === 0) {
    onProgress({ step: `All ${seedData.rounds.length} rounds already imported. Nothing to do.`, done: true, roundsOk: 0, roundsFailed: 0 });
    return;
  }

  onProgress({ step: `Found ${newRounds.length} new round(s) to import (${existingIds.size} already exist)...`, done: false });

  // Import new rounds (10 concurrent)
  let ok = 0;
  let failed = 0;
  const BATCH = 10;
  for (let i = 0; i < newRounds.length; i += BATCH) {
    const batch = newRounds.slice(i, i + BATCH);
    onProgress({ step: `Importing new rounds... ${i + 1}/${newRounds.length}`, done: false, roundsOk: ok, roundsFailed: failed });
    const results = await Promise.allSettled(
      batch.map((round) =>
        apiFetch('/ingest-event-results', { method: 'POST', body: JSON.stringify(round) })
      )
    );
    for (const r of results) {
      if (r.status === 'fulfilled') ok++;
      else failed++;
    }
  }

  onProgress({ step: `Done! ${ok} new rounds imported, ${failed} failed. (${existingIds.size} already existed)`, done: true, roundsOk: ok, roundsFailed: failed });
}
