/**
 * Integration test: external adapter → ingest-event-results → verify ledger and queue.
 * - Loads sample round from tests/fixtures/external-round.json
 * - Normalizes to ingest body via adapters/normalize.mjs
 * - POSTs to ingest-event-results
 * - Verifies: league_rounds created, league_scores for resolved players, unresolved in player_mapping_queue, standings updated
 *
 * Requires: supabase start, supabase db reset, supabase functions serve.
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { normalizeToIngest } from "../adapters/normalize.mjs";

try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const dotenv = await import("dotenv");
  dotenv.config({ path: join(__dirname, "..", ".env") });
} catch { /* optional */ }

const BASE = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FUNCTIONS = `${BASE}/functions/v1`;

const GROUP_ID = "group-seed-001";
const SEASON_ID = "season-seed-001";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  if (!ANON || !SERVICE_ROLE) {
    console.error("Missing SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY. See integration.mjs for setup.");
    process.exit(1);
  }

  const anon = createClient(BASE, ANON);
  const admin = createClient(BASE, SERVICE_ROLE, { auth: { persistSession: false } });

  console.log("1. Sign in as test user…");
  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({
    email: "test@lateadd.local",
    password: "testpass123",
  });
  if (signInErr) {
    console.error("Sign-in failed:", signInErr.message);
    process.exit(1);
  }
  const token = signIn.session.access_token;

  console.log("2. Load fixture and normalize to ingest body…");
  const __dirname2 = dirname(fileURLToPath(import.meta.url));
  const fixturePath = join(__dirname2, "fixtures", "external-round.json");
  const externalRound = JSON.parse(readFileSync(fixturePath, "utf8"));
  const ingestBody = normalizeToIngest(externalRound, {
    group_id: GROUP_ID,
    season_id: SEASON_ID,
    source_app: "adapter-test",
  });
  assert(ingestBody.scores.length === 4, "Fixture must have 4 player point rows");
  assert(ingestBody.external_event_id === "adapter-test-round-001", "event_id must become external_event_id");

  console.log("3. POST ingest-event-results…");
  const r = await fetch(`${FUNCTIONS}/ingest-event-results`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(ingestBody),
  });
  const body = await r.json().catch(() => ({}));
  assert(
    (r.status === 201 || r.status === 200) && body.league_round_id,
    `Expected 201/200 with league_round_id, got ${r.status}: ${JSON.stringify(body)}`
  );
  const leagueRoundId = body.league_round_id;
  console.log("   League round:", leagueRoundId);

  console.log("4. Verify league_rounds row…");
  const { data: round, error: roundErr } = await admin
    .from("league_rounds")
    .select("id, group_id, round_date, source_app, external_event_id")
    .eq("id", leagueRoundId)
    .maybeSingle();
  assert(!roundErr && round, `league_rounds row must exist: ${roundErr?.message ?? "not found"}`);
  assert(round.group_id === GROUP_ID, "group_id must match");
  assert(round.round_date === "2025-07-01", "round_date must match fixture");
  assert(round.source_app === "adapter-test", "source_app must match");
  assert(round.external_event_id === "adapter-test-round-001", "external_event_id must match");

  console.log("5. Verify league_scores (only resolved players: player-1, player-2)…");
  const { data: scores, error: scoresErr } = await admin
    .from("league_scores")
    .select("player_id, score_value")
    .eq("league_round_id", leagueRoundId);
  assert(!scoresErr && Array.isArray(scores), "league_scores query must succeed");
  assert(scores.length === 2, `Expected 2 league_scores (resolved only), got ${scores.length}`);
  const byPlayer = Object.fromEntries(scores.map((s) => [s.player_id, s.score_value]));
  assert(byPlayer["player-1"] === 3, "player-1 must have score_value 3");
  assert(byPlayer["player-2"] === -1, "player-2 must have score_value -1");

  console.log("6. Verify player_mapping_queue (unresolved: Alice From Export, Bob Unmapped)…");
  const { data: queue, error: queueErr } = await admin
    .from("player_mapping_queue")
    .select("id, source_app, source_player_name, status")
    .eq("status", "pending");
  assert(!queueErr && Array.isArray(queue), "player_mapping_queue query must succeed");
  const adapterQueue = queue.filter((q) => q.source_app === "adapter-test");
  assert(adapterQueue.length >= 2, `Expected at least 2 pending items for adapter-test, got ${adapterQueue.length}`);
  const names = adapterQueue.map((q) => q.source_player_name).sort();
  assert(
    names.includes("Alice From Export") && names.includes("Bob Unmapped"),
    `Queue must contain Alice From Export and Bob Unmapped, got ${names.join(", ")}`
  );

  console.log("7. Verify standings updated (player-1 and player-2)…");
  const rStandings = await fetch(
    `${FUNCTIONS}/get-standings?season_id=${SEASON_ID}&group_id=${GROUP_ID}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  assert(rStandings.status === 200, `get-standings expected 200, got ${rStandings.status}`);
  const { standings } = await rStandings.json();
  const p1 = standings?.find((s) => s.player_id === "player-1");
  const p2 = standings?.find((s) => s.player_id === "player-2");
  assert(p1 && p1.total_points >= 3, "player-1 must appear in standings with at least 3 points from this round");
  assert(p2 && p2.total_points >= -1, "player-2 must appear in standings");

  console.log("Adapter ingest integration test passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
