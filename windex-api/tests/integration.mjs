/**
 * Full happy-path integration test: seed user → auth → ingest → assert DB and standings.
 * Verifies points-ledger architecture: ingest creates atomic point records (league_scores);
 * round edit (PATCH) updates those records; standings are derived from the ledger only (step 5b).
 * Requires: supabase start, supabase db reset, supabase functions serve.
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (from `supabase start` output).
 * Loads .env from project root if dotenv is installed.
 */
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

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
const EXTERNAL_EVENT_ID = "integration-test-event-001";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  if (!ANON || !SERVICE_ROLE) {
    console.error("");
    console.error("Missing SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY.");
    console.error("");
    console.error("1. From the windex-api folder, run:  supabase start");
    console.error("2. In the output, copy the values for:");
    console.error("   - anon key");
    console.error("   - service_role key");
    console.error("3. Create a file named .env in the windex-api folder with (one per line, no line breaks inside a value):");
    console.error("   SUPABASE_URL=http://127.0.0.1:54321");
    console.error("   SUPABASE_ANON_KEY=<paste anon key here>");
    console.error("   SUPABASE_SERVICE_ROLE_KEY=<paste service_role key here>");
    console.error("4. For compute-money-deltas: copy these vars into supabase/functions/.env (see supabase/functions/.env.example) so the function has SUPABASE_SERVICE_ROLE_KEY when you run 'supabase functions serve'.");
    console.error("5. Run:  supabase functions serve  (then in another terminal)  npm run test:integration");
    console.error("");
    process.exit(1);
  }

  if (!BASE.includes("127.0.0.1") && !BASE.includes("localhost")) {
    console.warn("Warning: SUPABASE_URL is not local (127.0.0.1/localhost). For local tests use URL and keys from 'supabase start'.");
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
    console.error("Run: supabase db reset (to apply migrations + seed).");
    process.exit(1);
  }
  const token = signIn.session.access_token;

  const ingestBody = {
    group_id: GROUP_ID,
    season_id: SEASON_ID,
    round_date: "2025-06-15",
    source_app: "integration-test",
    external_event_id: EXTERNAL_EVENT_ID,
    scores: [
      { player_id: "player-1", score_value: 2 },
      { player_id: "player-2", score_value: -1 },
    ],
  };

  console.log("2. POST ingest-event-results (first time)…");
  const r1 = await fetch(`${FUNCTIONS}/ingest-event-results`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(ingestBody),
  });
  const body1 = await r1.json().catch(() => ({}));
  assert(
    (r1.status === 201 || r1.status === 200) && body1.league_round_id,
    `Expected 201 or 200 with league_round_id, got ${r1.status}: ${JSON.stringify(body1)}`
  );
  const leagueRoundId = body1.league_round_id;
  console.log("   League round:", leagueRoundId, r1.status === 201 ? "(created)" : "(already existed)");

  console.log("3. Assert one league_rounds row…");
  const { data: rounds, error: roundsErr } = await admin.from("league_rounds").select("id").eq("group_id", GROUP_ID);
  if (roundsErr) {
    throw new Error(`league_rounds query failed: ${roundsErr.message}. Ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env are from the same local 'supabase start' output.`);
  }
  if (!Array.isArray(rounds) || rounds.length === 0) {
    const hint = BASE.includes("127.0.0.1") || BASE.includes("localhost") ? "" : " For local tests, set SUPABASE_URL=http://127.0.0.1:54321 and use anon + service_role keys from 'supabase start'.";
    throw new Error(`Expected 1 league_rounds row, got ${rounds?.length ?? 0}. The function wrote to one instance but the test may be reading from another. Use SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY all from the same 'supabase start' output.${hint}`);
  }
  assert(rounds.length === 1, `Expected exactly 1 league_rounds row, got ${rounds.length}`);

  console.log("4. Assert two league_scores rows…");
  const { data: scores } = await admin.from("league_scores").select("player_id, score_value").eq("league_round_id", leagueRoundId);
  assert(Array.isArray(scores) && scores.length === 2, `Expected 2 league_scores rows, got ${scores?.length ?? 0}`);
  const byPlayer = Object.fromEntries(scores.map((s) => [s.player_id, s.score_value]));
  assert(byPlayer["player-1"] === 2 && byPlayer["player-2"] === -1, "Point values must be 2 and -1 (points mode)");

  console.log("5. GET get-standings and assert rounds_played and total_points…");
  const rStandings = await fetch(
    `${FUNCTIONS}/get-standings?season_id=${SEASON_ID}&group_id=${GROUP_ID}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  assert(rStandings.status === 200, `get-standings expected 200, got ${rStandings.status}`);
  const { standings } = await rStandings.json();
  assert(Array.isArray(standings) && standings.length === 2, `Expected 2 standings rows, got ${standings?.length ?? 0}`);
  const pts = standings.map((s) => ({ player_id: s.player_id, rounds_played: s.rounds_played, total_points: s.total_points }));
  assert(pts.every((p) => p.rounds_played === 1), "Each player should have rounds_played = 1");
  const totalSet = new Set(pts.map((p) => p.total_points));
  assert(totalSet.has(2) && totalSet.has(-1), "total_points should be 2 and -1 (standings derived from ledger)");

  console.log("5b. Points ledger: round edit (PATCH) updates atomic point records; standings reflect ledger…");
  const rPatch = await fetch(`${FUNCTIONS}/events/${leagueRoundId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      results: [
        { player_id: "player-1", score_value: 2, score_override: 5 },
        { player_id: "player-2", score_value: -1 },
      ],
      override_actor: "integration-test",
      override_reason: "ledger test",
    }),
  });
  assert(rPatch.status === 200, `PATCH events/:id expected 200, got ${rPatch.status}: ${await rPatch.text().catch(() => "")}`);
  const rDetail = await fetch(`${FUNCTIONS}/events/${leagueRoundId}`, { headers: { Authorization: `Bearer ${token}` } });
  assert(rDetail.status === 200, `GET event detail expected 200, got ${rDetail.status}`);
  const detailBody = await rDetail.json().catch(() => ({}));
  const p1Result = (detailBody.results ?? []).find((r) => r.player_id === "player-1");
  assert(p1Result?.score_override === 5, `Event detail results must show player-1 score_override 5, got ${JSON.stringify(p1Result)}`);
  assert(p1Result?.override_reason === "ledger test", `Event detail must return override_reason for overridden score, got ${JSON.stringify(p1Result?.override_reason)}`);
  assert(p1Result?.override_actor === "integration-test", `Event detail must return override_actor for overridden score, got ${JSON.stringify(p1Result?.override_actor)}`);
  assert(typeof p1Result?.override_at === "string" && p1Result.override_at.length > 0, `Event detail must return override_at for overridden score, got ${JSON.stringify(p1Result?.override_at)}`);
  const { data: scoresAfterPatch } = await admin.from("league_scores").select("player_id, score_value, score_override").eq("league_round_id", leagueRoundId);
  const p1After = scoresAfterPatch?.find((s) => s.player_id === "player-1");
  assert(p1After?.score_override === 5, `Ledger row must have score_override 5 after PATCH, got ${JSON.stringify(p1After)}`);
  const rStandings2 = await fetch(
    `${FUNCTIONS}/get-standings?season_id=${SEASON_ID}&group_id=${GROUP_ID}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { standings: standings2 } = await rStandings2.json();
  const p1Standing = standings2?.find((s) => s.player_id === "player-1");
  assert(p1Standing?.total_points === 5, `Standings must reflect ledger (player-1 total_points 5), got ${p1Standing?.total_points}`);
  const rPatchRestore = await fetch(`${FUNCTIONS}/events/${leagueRoundId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      results: [
        { player_id: "player-1", score_value: 2 },
        { player_id: "player-2", score_value: -1 },
      ],
    }),
  });
  assert(rPatchRestore.status === 200, `PATCH restore expected 200, got ${rPatchRestore.status}`);

  console.log("5c. Standings player history: round-level point records; total matches sum of effective_points…");
  const rHistory = await fetch(
    `${FUNCTIONS}/standings-player-history?group_id=${GROUP_ID}&season_id=${SEASON_ID}&player_id=player-1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  assert(rHistory.status === 200, `standings-player-history expected 200, got ${rHistory.status}: ${await rHistory.text().catch(() => "")}`);
  const bodyHistory = await rHistory.json().catch(() => ({}));
  assert(Array.isArray(bodyHistory.history), "Response must include history array");
  assert(bodyHistory.player_id === "player-1", "player_id must be player-1");
  const sumEffective = (bodyHistory.history ?? []).reduce((s, row) => s + (row.effective_points ?? 0), 0);
  assert(bodyHistory.total_points === sumEffective, `total_points (${bodyHistory.total_points}) must equal sum of effective_points (${sumEffective})`);
  assert((bodyHistory.history ?? []).length >= 1, "player-1 must have at least one round in history");
  const firstRow = bodyHistory.history[0];
  assert(firstRow.event_id && firstRow.round_date != null && firstRow.effective_points != null, "Each history row must have event_id, round_date, effective_points");

  console.log("6. Idempotency: POST same (source_app + external_event_id) again → 200…");
  const r2 = await fetch(`${FUNCTIONS}/ingest-event-results`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(ingestBody),
  });
  const body2 = await r2.json().catch(() => ({}));
  assert(r2.status === 200, `Idempotent request expected 200, got ${r2.status}: ${JSON.stringify(body2)}`);
  assert(body2.league_round_id === leagueRoundId, "Must return same league_round_id");

  console.log("7. POST compute-money-deltas → 200, computed: false (no_payout_config)…");
  const rMoney = await fetch(`${FUNCTIONS}/compute-money-deltas`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ league_round_id: leagueRoundId }),
  });
  assert(rMoney.status === 200, `compute-money-deltas expected 200, got ${rMoney.status}`);
  const bodyMoney = await rMoney.json().catch(() => ({}));
  assert(bodyMoney.computed === false && bodyMoney.reason === "no_payout_config", `Expected computed: false, reason: no_payout_config, got ${JSON.stringify(bodyMoney)}`);
  assert(bodyMoney.league_round_id === leagueRoundId, "Response must include same league_round_id");
  const { data: scoresAfter } = await admin.from("league_scores").select("money_delta").eq("league_round_id", leagueRoundId);
  assert(scoresAfter?.every((s) => s.money_delta == null), "money_delta must remain NULL when no payout config");

  console.log("8. Set group dollars_per_point = 2, then compute-money-deltas → computed: true…");
  const { error: groupUpErr } = await admin.from("groups").update({ dollars_per_point: 2 }).eq("id", GROUP_ID);
  assert(!groupUpErr, `Failed to set dollars_per_point: ${groupUpErr?.message}`);
  const rCompute = await fetch(`${FUNCTIONS}/compute-money-deltas`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ league_round_id: leagueRoundId }),
  });
  const bodyComputeRaw = await rCompute.json().catch(() => ({}));
  assert(rCompute.status === 200, `compute-money-deltas expected 200, got ${rCompute.status}: ${JSON.stringify(bodyComputeRaw)}`);
  assert(bodyComputeRaw.computed === true && bodyComputeRaw.updated === 2, `Expected computed: true, updated: 2, got ${JSON.stringify(bodyComputeRaw)}`);

  console.log("9. Assert money_delta zero-sum and values (points 2, -1 → mean 0.5 → deltas 3, -3)…");
  const { data: scoresWithMoney } = await admin.from("league_scores").select("player_id, money_delta").eq("league_round_id", leagueRoundId);
  const sumDelta = scoresWithMoney?.reduce((s, r) => s + (r.money_delta ?? 0), 0) ?? NaN;
  assert(sumDelta === 0, `money_delta must sum to 0, got ${sumDelta}`);
  const deltasByPlayer = Object.fromEntries((scoresWithMoney ?? []).map((s) => [s.player_id, s.money_delta]));
  assert(deltasByPlayer["player-1"] === 3 && deltasByPlayer["player-2"] === -3, `Expected player-1=3, player-2=-3, got ${JSON.stringify(deltasByPlayer)}`);

  console.log("9b. generate-payment-requests (two-player, one request)…");
  const rGen = await fetch(`${FUNCTIONS}/generate-payment-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ league_round_id: leagueRoundId }),
  });
  assert(rGen.status === 200, `generate-payment-requests expected 200, got ${rGen.status}: ${JSON.stringify(await rGen.json().catch(() => ({})))}`);
  const bodyGen = await rGen.json().catch(() => ({}));
  assert(bodyGen.league_round_id === leagueRoundId && Array.isArray(bodyGen.requests), "Response must include league_round_id and requests");
  assert(bodyGen.requests.length === 1, `Expected 1 request, got ${bodyGen.requests.length}`);
  assert(bodyGen.requests[0].from_player_id === "player-2" && bodyGen.requests[0].to_player_id === "player-1" && bodyGen.requests[0].amount_cents === 300, `Expected player-2 -> player-1 300 cents, got ${JSON.stringify(bodyGen.requests[0])}`);

  console.log("9c. generate-payment-requests deterministic (repeat same output)…");
  const rGen2 = await fetch(`${FUNCTIONS}/generate-payment-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ league_round_id: leagueRoundId }),
  });
  const bodyGen2 = await rGen2.json().catch(() => ({}));
  assert(JSON.stringify(bodyGen.requests) === JSON.stringify(bodyGen2.requests), "Repeat call must return same requests");

  console.log("10. Rerun compute-money-deltas (idempotent) → same deltas…");
  const rRerun = await fetch(`${FUNCTIONS}/compute-money-deltas`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ league_round_id: leagueRoundId }),
  });
  assert(rRerun.status === 200, `rerun expected 200, got ${rRerun.status}`);
  const { data: scoresRerun } = await admin.from("league_scores").select("player_id, money_delta").eq("league_round_id", leagueRoundId);
  const deltasRerun = Object.fromEntries((scoresRerun ?? []).map((s) => [s.player_id, s.money_delta]));
  assert(deltasRerun["player-1"] === 3 && deltasRerun["player-2"] === -3, `After rerun expected 3 and -3, got ${JSON.stringify(deltasRerun)}`);

  console.log("11. Override player-1 points to 1, recompute → new deltas (1, -1 mean 0 → 2, -2)…");
  const { data: scoreRows } = await admin.from("league_scores").select("id").eq("league_round_id", leagueRoundId).eq("player_id", "player-1");
  assert(scoreRows?.length === 1, "Need one league_scores row for player-1");
  await admin.from("league_scores").update({ score_override: 1 }).eq("id", scoreRows[0].id);
  const rOverride = await fetch(`${FUNCTIONS}/compute-money-deltas`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ league_round_id: leagueRoundId }),
  });
  assert(rOverride.status === 200, `compute after override expected 200, got ${rOverride.status}`);
  const { data: scoresOverride } = await admin.from("league_scores").select("player_id, money_delta").eq("league_round_id", leagueRoundId);
  const deltasOverride = Object.fromEntries((scoresOverride ?? []).map((s) => [s.player_id, s.money_delta]));
  assert(deltasOverride["player-1"] === 2 && deltasOverride["player-2"] === -2, `After override expected 2 and -2, got ${JSON.stringify(deltasOverride)}`);
  const sumOverride = scoresOverride?.reduce((s, r) => s + (r.money_delta ?? 0), 0) ?? NaN;
  assert(sumOverride === 0, "Zero-sum must hold after override recompute");

  console.log("12. Ingest second round (same points 0,0), compute → all money_delta 0…");
  const rIngest2 = await fetch(`${FUNCTIONS}/ingest-event-results`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      group_id: GROUP_ID,
      season_id: SEASON_ID,
      round_date: "2025-06-16",
      source_app: "integration-test",
      external_event_id: "integration-test-event-002",
      scores: [
        { player_id: "player-1", score_value: 0 },
        { player_id: "player-2", score_value: 0 },
      ],
    }),
  });
  const bodyIngest2 = await rIngest2.json().catch(() => ({}));
  assert((rIngest2.status === 201 || rIngest2.status === 200) && bodyIngest2.league_round_id, `Second ingest failed: ${rIngest2.status} ${JSON.stringify(bodyIngest2)}`);
  const roundId2 = bodyIngest2.league_round_id;
  const rCompute2 = await fetch(`${FUNCTIONS}/compute-money-deltas`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ league_round_id: roundId2 }),
  });
  assert(rCompute2.status === 200, `compute round 2 expected 200, got ${rCompute2.status}`);
  const { data: scoresRound2 } = await admin.from("league_scores").select("money_delta").eq("league_round_id", roundId2);
  assert(scoresRound2?.every((s) => s.money_delta === 0), `All same points must yield money_delta 0, got ${JSON.stringify(scoresRound2)}`);

  console.log("12b. generate-payment-requests all zero deltas → empty requests…");
  const rGenZero = await fetch(`${FUNCTIONS}/generate-payment-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ league_round_id: roundId2 }),
  });
  assert(rGenZero.status === 200, `generate-payment-requests (all zeros) expected 200, got ${rGenZero.status}`);
  const bodyGenZero = await rGenZero.json().catch(() => ({}));
  assert(Array.isArray(bodyGenZero.requests) && bodyGenZero.requests.length === 0, "All zero deltas must yield empty requests");

  console.log("12c. generate-payment-requests before compute (NULL money_delta) → 400…");
  const rIngest3 = await fetch(`${FUNCTIONS}/ingest-event-results`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      group_id: GROUP_ID,
      season_id: SEASON_ID,
      round_date: "2025-06-17",
      source_app: "integration-test",
      external_event_id: "integration-test-event-003",
      scores: [
        { player_id: "player-1", score_value: 1 },
        { player_id: "player-2", score_value: -1 },
      ],
    }),
  });
  const bodyIngest3 = await rIngest3.json().catch(() => ({}));
  const roundId3 = bodyIngest3.league_round_id;
  if (roundId3) {
    const rGenNull = await fetch(`${FUNCTIONS}/generate-payment-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ league_round_id: roundId3 }),
    });
    assert(rGenNull.status === 400, `generate-payment-requests (NULL money_delta) expected 400, got ${rGenNull.status}`);
    const bodyGenNull = await rGenNull.json().catch(() => ({}));
    assert(bodyGenNull.code === "money_delta_not_computed", `Expected code money_delta_not_computed, got ${bodyGenNull.code}`);
  }

  console.log("13. Reject invalid player_id → 400 invalid_player_ids…");
  const r3 = await fetch(`${FUNCTIONS}/ingest-event-results`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      group_id: GROUP_ID,
      round_date: "2025-06-16",
      scores: [
        { player_id: "player-1", score_value: 0 },
        { player_id: "non-member-player", score_value: 1 },
      ],
    }),
  });
  assert(r3.status === 400, `Invalid player expected 400, got ${r3.status}`);
  const body3 = await r3.json().catch(() => ({}));
  assert(
    Array.isArray(body3.invalid_player_ids) && body3.invalid_player_ids.includes("non-member-player"),
    "Response must include invalid_player_ids with non-member-player"
  );

  console.log("14. Player mapping: GET queue → resolve first item → queue shrinks…");
  const rQueue = await fetch(`${FUNCTIONS}/review/player-mapping`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(rQueue.status === 200, `GET review/player-mapping expected 200, got ${rQueue.status}`);
  const bodyQueue = await rQueue.json().catch(() => ({}));
  assert(Array.isArray(bodyQueue.items), "Response must include items array");
  const queueBefore = bodyQueue.items.length;
  const mappingId = bodyQueue.items[0]?.id;
  if (mappingId) {
    const rResolve = await fetch(`${FUNCTIONS}/review/player-mapping/${mappingId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ player_id: "player-1" }),
    });
    assert(rResolve.status === 200, `POST resolve expected 200, got ${rResolve.status}: ${await rResolve.text()}`);
    const rQueue2 = await fetch(`${FUNCTIONS}/review/player-mapping`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const bodyQueue2 = await rQueue2.json().catch(() => ({}));
    assert(bodyQueue2.items.length === queueBefore - 1, `After resolve pending queue should have one fewer item, got ${bodyQueue2.items.length}`);
    const { data: mappingRow } = await admin.from("player_mappings").select("canonical_player_id").eq("user_id", signIn.user.id).eq("source_player_ref", "Unknown Golfer").maybeSingle();
    assert(mappingRow?.canonical_player_id === "player-1", `player_mappings must store canonical_player_id player-1, got ${mappingRow?.canonical_player_id}`);
  }

  console.log("15. Ingest with source identity: resolved mapping used, unresolved → queue…");
  const rIngestMapping = await fetch(`${FUNCTIONS}/ingest-event-results`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      group_id: GROUP_ID,
      season_id: SEASON_ID,
      round_date: "2025-06-18",
      source_app: "integration-test",
      external_event_id: "ingest-mapping-001",
      scores: [
        { source_player_name: "Unknown Golfer", score_value: 2 },
        { source_player_name: "Newcomer", score_value: -1 },
      ],
    }),
  });
  assert(rIngestMapping.status === 201, `ingest with source identity expected 201, got ${rIngestMapping.status}: ${await rIngestMapping.text()}`);
  const bodyIngestMapping = await rIngestMapping.json().catch(() => ({}));
  const roundMappingId = bodyIngestMapping.league_round_id;
  assert(roundMappingId, "Response must include league_round_id");
  const { data: roundRow } = await admin.from("league_rounds").select("processing_status, unresolved_player_count").eq("id", roundMappingId).maybeSingle();
  assert(roundRow?.processing_status === "partial_unresolved_players", `Expected processing_status partial_unresolved_players, got ${roundRow?.processing_status}`);
  assert(roundRow?.unresolved_player_count === 1, `Expected unresolved_player_count 1, got ${roundRow?.unresolved_player_count}`);
  const { data: scoresMapping } = await admin.from("league_scores").select("player_id, score_value").eq("league_round_id", roundMappingId);
  assert(Array.isArray(scoresMapping) && scoresMapping.length === 1, `Expected 1 league_score (only resolved), got ${scoresMapping?.length ?? 0}`);
  assert(scoresMapping[0].player_id === "player-1" && scoresMapping[0].score_value === 2, `Expected player-1 with 2, got ${JSON.stringify(scoresMapping[0])}`);
  const { data: queueNewcomer } = await admin.from("player_mapping_queue").select("id").eq("user_id", signIn.user.id).eq("status", "pending").eq("source_app", "integration-test").eq("source_player_name", "Newcomer");
  assert(Array.isArray(queueNewcomer) && queueNewcomer.length === 1, `Expected one pending queue row for Newcomer (integration-test), got ${queueNewcomer?.length ?? 0}`);

  console.log("16. Re-ingest with same unresolved identity → no duplicate pending queue row…");
  const rIngestMapping2 = await fetch(`${FUNCTIONS}/ingest-event-results`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      group_id: GROUP_ID,
      season_id: SEASON_ID,
      round_date: "2025-06-19",
      source_app: "integration-test",
      external_event_id: "ingest-mapping-002",
      scores: [
        { source_player_name: "Unknown Golfer", score_value: 0 },
        { source_player_name: "Newcomer", score_value: 1 },
      ],
    }),
  });
  assert(rIngestMapping2.status === 201, `second ingest with source identity expected 201, got ${rIngestMapping2.status}`);
  const { data: pendingNewcomerAfter } = await admin.from("player_mapping_queue").select("id").eq("user_id", signIn.user.id).eq("status", "pending").eq("source_app", "integration-test").eq("source_player_name", "Newcomer");
  assert(Array.isArray(pendingNewcomerAfter) && pendingNewcomerAfter.length === 1, `Duplicate prevention: expected exactly 1 pending row for Newcomer, got ${pendingNewcomerAfter?.length ?? 0}`);

  console.log("17. Fully resolved ingest → processed; GET events list/detail return status…");
  const rIngestFull = await fetch(`${FUNCTIONS}/ingest-event-results`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      group_id: GROUP_ID,
      season_id: SEASON_ID,
      round_date: "2025-06-20",
      source_app: "integration-test",
      external_event_id: "ingest-status-001",
      scores: [
        { player_id: "player-1", score_value: 1 },
        { player_id: "player-2", score_value: -1 },
      ],
    }),
  });
  assert(rIngestFull.status === 201, `fully resolved ingest expected 201, got ${rIngestFull.status}`);
  const bodyFull = await rIngestFull.json().catch(() => ({}));
  const roundFullId = bodyFull.league_round_id;
  const { data: roundFull } = await admin.from("league_rounds").select("processing_status, unresolved_player_count").eq("id", roundFullId).maybeSingle();
  assert(roundFull?.processing_status === "processed", `Expected processing_status processed for full ingest, got ${roundFull?.processing_status}`);
  assert(roundFull?.unresolved_player_count === 0, `Expected unresolved_player_count 0, got ${roundFull?.unresolved_player_count}`);

  const rList = await fetch(`${FUNCTIONS}/events?status=partial_unresolved_players`, { headers: { Authorization: `Bearer ${token}` } });
  assert(rList.status === 200, `GET events?status=partial_unresolved_players expected 200, got ${rList.status}`);
  const bodyList = await rList.json().catch(() => ({}));
  assert(Array.isArray(bodyList.events), "Response must include events array");
  const partialEvent = bodyList.events.find((e) => e.id === roundMappingId);
  assert(partialEvent?.status === "partial_unresolved_players" && partialEvent?.unresolved_player_count === 1, `Event list must return status and count for partial round, got ${JSON.stringify(partialEvent)}`);

  const rDetail = await fetch(`${FUNCTIONS}/events/${roundMappingId}`, { headers: { Authorization: `Bearer ${token}` } });
  assert(rDetail.status === 200, `GET events/:id expected 200, got ${rDetail.status}`);
  const bodyDetail = await rDetail.json().catch(() => ({}));
  assert(bodyDetail.status === "partial_unresolved_players" && bodyDetail.unresolved_player_count === 1, `Event detail must return status and count, got ${JSON.stringify({ status: bodyDetail.status, count: bodyDetail.unresolved_player_count })}`);
  assert(Array.isArray(bodyDetail.mapping_issues) && bodyDetail.mapping_issues.length > 0, "Event detail must include mapping_issues for partial round");

  console.log("18. Attribution: ingest without season_id → pending; resolve → attribution_resolved; events show attribution_status…");
  const rIngestNoSeason = await fetch(`${FUNCTIONS}/ingest-event-results`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      group_id: GROUP_ID,
      round_date: "2025-06-21",
      source_app: "integration-test",
      external_event_id: "ingest-attribution-001",
      scores: [
        { player_id: "player-1", score_value: 0 },
        { player_id: "player-2", score_value: 0 },
      ],
    }),
  });
  assert(rIngestNoSeason.status === 201, `ingest without season_id expected 201, got ${rIngestNoSeason.status}`);
  const bodyNoSeason = await rIngestNoSeason.json().catch(() => ({}));
  const roundAttribId = bodyNoSeason.league_round_id;
  const { data: roundAttrib } = await admin.from("league_rounds").select("attribution_status").eq("id", roundAttribId).maybeSingle();
  assert(roundAttrib?.attribution_status === "pending_attribution", `Expected attribution_status pending_attribution, got ${roundAttrib?.attribution_status}`);

  const rAttrQueue = await fetch(`${FUNCTIONS}/review/attribution`, { headers: { Authorization: `Bearer ${token}` } });
  assert(rAttrQueue.status === 200, `GET review/attribution expected 200, got ${rAttrQueue.status}`);
  const bodyAttrQueue = await rAttrQueue.json().catch(() => ({}));
  assert(Array.isArray(bodyAttrQueue.items), "Response must include items array");
  const attribItem = bodyAttrQueue.items.find((i) => i.id === roundAttribId);
  assert(attribItem, "Pending attribution queue must include the round");

  const rAttrResolve = await fetch(`${FUNCTIONS}/review/attribution/${roundAttribId}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ group_id: GROUP_ID, season_id: SEASON_ID }),
  });
  assert(rAttrResolve.status === 200, `POST resolve attribution expected 200, got ${rAttrResolve.status}: ${await rAttrResolve.text()}`);

  const { data: roundAfter } = await admin.from("league_rounds").select("attribution_status, group_id, season_id").eq("id", roundAttribId).maybeSingle();
  assert(roundAfter?.attribution_status === "attribution_resolved", `Expected attribution_resolved, got ${roundAfter?.attribution_status}`);
  assert(roundAfter?.group_id === GROUP_ID && roundAfter?.season_id === SEASON_ID, "Round must have updated group_id and season_id");

  const rAttrQueue2 = await fetch(`${FUNCTIONS}/review/attribution`, { headers: { Authorization: `Bearer ${token}` } });
  const bodyAttrQueue2 = await rAttrQueue2.json().catch(() => ({}));
  const stillPending = bodyAttrQueue2.items?.filter((i) => i.id === roundAttribId) ?? [];
  assert(stillPending.length === 0, "Resolved round must no longer be in attribution queue");

  const rEventDetail = await fetch(`${FUNCTIONS}/events/${roundMappingId}`, { headers: { Authorization: `Bearer ${token}` } });
  const bodyEventDetail = await rEventDetail.json().catch(() => ({}));
  assert(bodyEventDetail.attribution_status != null, "Event detail must include attribution_status");

  console.log("\nAll integration checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
