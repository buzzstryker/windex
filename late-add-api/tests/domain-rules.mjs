/**
 * Domain rule tests for Windex backend.
 * Verifies business rules (scoring mode, event structure, membership, idempotency, override, standings).
 * Requires: supabase start, supabase db reset, supabase functions serve.
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
 */
import { createClient } from "@supabase/supabase-js";

try { await import("dotenv/config"); } catch { /* optional */ }

const BASE = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FUNCTIONS = `${BASE}/functions/v1`;

const GROUP_POINTS = "group-seed-001";
const GROUP_WINLOSS = "group-seed-002";
const SEASON_POINTS = "season-seed-001";
const SEASON_WINLOSS = "season-seed-002";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function getToken() {
  const anon = createClient(BASE, ANON);
  const { data, error } = await anon.auth.signInWithPassword({
    email: "test@lateadd.local",
    password: "testpass123",
  });
  if (error) throw new Error("Sign-in failed: " + error.message);
  return data.session.access_token;
}

async function ingest(token, body) {
  const r = await fetch(`${FUNCTIONS}/ingest-event-results`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, ...json };
}

async function getStandings(token, seasonId, groupId = null) {
  const url = `${FUNCTIONS}/get-standings?season_id=${seasonId}` + (groupId ? `&group_id=${groupId}` : "");
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, standings: json.standings ?? [] };
}

async function runTests() {
  if (!ANON || !SERVICE_ROLE) {
    console.error("Set SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const admin = createClient(BASE, SERVICE_ROLE, { auth: { persistSession: false } });
  const token = await getToken();
  let passed = 0;
  let failed = 0;

  const ok = (name, cond, detail = "") => {
    if (cond) { console.log("  OK   ", name); passed++; } else { console.log("  FAIL ", name, detail); failed++; }
  };

  console.log("\n--- 1. Windex stores points, not raw golf scores ---");
  const rStroke = await ingest(token, {
    group_id: GROUP_POINTS,
    season_id: SEASON_POINTS,
    round_date: "2025-06-01",
    source_app: "domain-test",
    external_event_id: "domain-stroke-reject",
    scores: [
      { player_id: "player-1", score_value: 72 },
      { player_id: "player-2", score_value: 75 },
    ],
  });
  ok("Reject raw stroke scores (72, 75) in points mode", rStroke.status === 400 && (rStroke.code === "raw_stroke_score_rejected" || rStroke.error?.includes("raw golf")), `status=${rStroke.status} code=${rStroke.code}`);

  const rOutOfRange = await ingest(token, {
    group_id: GROUP_POINTS,
    round_date: "2025-06-02",
    source_app: "domain-test",
    external_event_id: "domain-range-reject",
    scores: [
      { player_id: "player-1", score_value: 15 },
      { player_id: "player-2", score_value: -1 },
    ],
  });
  ok("Reject points out of range (e.g. 15) in points mode", rOutOfRange.status === 400 && (rOutOfRange.code === "points_out_of_range" || rOutOfRange.error?.includes("between")), `status=${rOutOfRange.status}`);

  console.log("\n--- 2. Valid points ingest ---");
  const rValid = await ingest(token, {
    group_id: GROUP_POINTS,
    season_id: SEASON_POINTS,
    round_date: "2025-06-10",
    source_app: "domain-test",
    external_event_id: "domain-valid-points-001",
    scores: [
      { player_id: "player-1", score_value: 2 },
      { player_id: "player-2", score_value: -1 },
    ],
  });
  ok("Valid points ingest returns 201", rValid.status === 201 && rValid.league_round_id, `status=${rValid.status}`);
  if (rValid.status === 201) {
    const { data: rounds } = await admin.from("league_rounds").select("id").eq("group_id", GROUP_POINTS).eq("external_event_id", "domain-valid-points-001");
    ok("Exactly one league_round for event", Array.isArray(rounds) && rounds.length === 1);
    const { data: scores } = await admin.from("league_scores").select("player_id, score_value").eq("league_round_id", rValid.league_round_id);
    const byP = Object.fromEntries((scores ?? []).map((s) => [s.player_id, s.score_value]));
    ok("Expected league_scores (2 and -1)", byP["player-1"] === 2 && byP["player-2"] === -1);
  }

  console.log("\n--- 3. Event structure: season must belong to group ---");
  const rMismatch = await ingest(token, {
    group_id: GROUP_POINTS,
    season_id: SEASON_WINLOSS,
    round_date: "2025-06-11",
    source_app: "domain-test",
    external_event_id: "domain-mismatch",
    scores: [
      { player_id: "player-1", score_value: 0 },
      { player_id: "player-2", score_value: 0 },
    ],
  });
  ok("Reject season_id that belongs to another group", rMismatch.status === 400 && (rMismatch.code === "season_group_mismatch" || rMismatch.error?.includes("season")), `status=${rMismatch.status} code=${rMismatch.code}`);

  console.log("\n--- 4. Membership: only active group members ---");
  const rInvalidPlayer = await ingest(token, {
    group_id: GROUP_POINTS,
    round_date: "2025-06-12",
    scores: [
      { player_id: "player-1", score_value: 0 },
      { player_id: "non-member", score_value: 1 },
    ],
  });
  ok("Reject non-member player with invalid_player_ids", rInvalidPlayer.status === 400 && Array.isArray(rInvalidPlayer.invalid_player_ids) && rInvalidPlayer.invalid_player_ids.includes("non-member"), `status=${rInvalidPlayer.status}`);

  console.log("\n--- 5. Idempotency: same external_event_id twice ---");
  const extId = "domain-idempotent-001";
  const rDup1 = await ingest(token, {
    group_id: GROUP_POINTS,
    season_id: SEASON_POINTS,
    round_date: "2025-06-13",
    source_app: "domain-test",
    external_event_id: extId,
    scores: [
      { player_id: "player-1", score_value: 1 },
      { player_id: "player-2", score_value: 0 },
    ],
  });
  const rDup2 = await ingest(token, {
    group_id: GROUP_POINTS,
    season_id: SEASON_POINTS,
    round_date: "2025-06-13",
    source_app: "domain-test",
    external_event_id: extId,
    scores: [
      { player_id: "player-1", score_value: 1 },
      { player_id: "player-2", score_value: 0 },
    ],
  });
  ok("First submit 201", rDup1.status === 201);
  ok("Second submit 200, same league_round_id", rDup2.status === 200 && rDup2.league_round_id === rDup1.league_round_id);
  const { data: dupRounds } = await admin.from("league_rounds").select("id").eq("group_id", GROUP_POINTS).eq("external_event_id", extId);
  ok("No duplicate league_rounds row", Array.isArray(dupRounds) && dupRounds.length === 1);

  console.log("\n--- 6. Override: actor, reason, timestamp; standings use effective result ---");
  const rOverride = await ingest(token, {
    group_id: GROUP_POINTS,
    season_id: SEASON_POINTS,
    round_date: "2025-06-14",
    source_app: "domain-test",
    external_event_id: "domain-override-001",
    scores: [
      { player_id: "player-1", score_value: 0, score_override: 3, override_actor: "admin@test", override_reason: "Correction" },
      { player_id: "player-2", score_value: 1 },
    ],
  });
  ok("Ingest with override returns 201", rOverride.status === 201);
  if (rOverride.status === 201) {
    const { data: ovScores } = await admin.from("league_scores").select("player_id, score_value, score_override, override_actor, override_reason, override_at").eq("league_round_id", rOverride.league_round_id);
    const p1 = (ovScores ?? []).find((s) => s.player_id === "player-1");
    ok("Override stored: actor, reason, override_at", p1 && p1.override_actor === "admin@test" && p1.override_reason === "Correction" && p1.override_at != null);
    ok("Effective score is override (3)", p1 && (p1.score_override === 3));
    const st = await getStandings(token, SEASON_POINTS, GROUP_POINTS);
    const p1Standing = (st.standings ?? []).find((s) => s.player_id === "player-1");
    ok("Standings use effective result (override)", p1Standing != null && p1Standing.total_points >= 3);
  }

  console.log("\n--- 7. win_loss_override: result_type win/loss/tie accepted and stored as points ---");
  const rWinLoss = await ingest(token, {
    group_id: GROUP_WINLOSS,
    season_id: SEASON_WINLOSS,
    round_date: "2025-06-15",
    source_app: "domain-test",
    external_event_id: "domain-winloss-001",
    scores: [
      { player_id: "player-1", result_type: "win" },
      { player_id: "player-2", result_type: "loss" },
    ],
  });
  ok("win_loss_override ingest returns 201", rWinLoss.status === 201);
  if (rWinLoss.status === 201) {
    const { data: wlScores } = await admin.from("league_scores").select("player_id, score_value, result_type").eq("league_round_id", rWinLoss.league_round_id);
    const w = (wlScores ?? []).find((s) => s.player_id === "player-1");
    const l = (wlScores ?? []).find((s) => s.player_id === "player-2");
    ok("Stored points: win=1, loss=0", w?.score_value === 1 && w?.result_type === "win" && l?.score_value === 0 && l?.result_type === "loss");
    const st = await getStandings(token, SEASON_WINLOSS, GROUP_WINLOSS);
    ok("Standings derive from event results (not settlements)", Array.isArray(st.standings) && st.standings.length >= 2);
  }

  console.log("\n--- 8. Multi-group: result belongs to exactly one group; player can be in multiple groups ---");
  const rGroup1 = await ingest(token, {
    group_id: GROUP_POINTS,
    season_id: SEASON_POINTS,
    round_date: "2025-06-16",
    source_app: "domain-test",
    external_event_id: "domain-multi-a",
    scores: [
      { player_id: "player-1", score_value: 2 },
      { player_id: "player-2", score_value: -1 },
    ],
  });
  const rGroup2 = await ingest(token, {
    group_id: GROUP_WINLOSS,
    season_id: SEASON_WINLOSS,
    round_date: "2025-06-16",
    source_app: "domain-test",
    external_event_id: "domain-multi-b",
    scores: [
      { player_id: "player-1", result_type: "loss" },
      { player_id: "player-2", result_type: "win" },
    ],
  });
  ok("Submit to group A (points) 201", rGroup1.status === 201);
  ok("Submit to group B (win_loss) 201", rGroup2.status === 201);
  const { data: roundsA } = await admin.from("league_rounds").select("id").eq("group_id", GROUP_POINTS).eq("external_event_id", "domain-multi-a");
  const { data: roundsB } = await admin.from("league_rounds").select("id").eq("group_id", GROUP_WINLOSS).eq("external_event_id", "domain-multi-b");
  ok("Exactly one round per group for multi-group submit", Array.isArray(roundsA) && roundsA.length === 1 && Array.isArray(roundsB) && roundsB.length === 1);
  const stA = await getStandings(token, SEASON_POINTS, GROUP_POINTS);
  const stB = await getStandings(token, SEASON_WINLOSS, GROUP_WINLOSS);
  ok("Standings per group (no cross-group ambiguity)", stA.standings?.some((s) => s.player_id === "player-1") && stB.standings?.some((s) => s.player_id === "player-1"));

  console.log("\n--- 9. Override metadata required when score_override set ---");
  const rNoMeta = await ingest(token, {
    group_id: GROUP_POINTS,
    round_date: "2025-06-17",
    source_app: "domain-test",
    external_event_id: "domain-no-override-meta",
    scores: [
      { player_id: "player-1", score_value: 0, score_override: 2 },
      { player_id: "player-2", score_value: 0 },
    ],
  });
  ok("Reject override without override_actor/override_reason", rNoMeta.status === 400 && (rNoMeta.code === "override_metadata_required" || rNoMeta.error?.includes("override")), `status=${rNoMeta.status}`);

  console.log("\n--- 10. Payout (compute-money-deltas): no config → computed false; with config → computed true, zero-sum ---");
  const rNoPayoutRound = await ingest(token, {
    group_id: GROUP_WINLOSS,
    season_id: SEASON_WINLOSS,
    round_date: "2025-06-18",
    source_app: "domain-test",
    external_event_id: "domain-payout-no-config",
    scores: [
      { player_id: "player-1", result_type: "win" },
      { player_id: "player-2", result_type: "loss" },
    ],
  });
  const roundIdNoConfig = rNoPayoutRound.league_round_id;
  if (roundIdNoConfig) {
    const rCompNo = await fetch(`${FUNCTIONS}/compute-money-deltas`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ league_round_id: roundIdNoConfig }),
    });
    const bodyNo = await rCompNo.json().catch(() => ({}));
    ok("No payout config (group dollars_per_point NULL) → computed: false", rCompNo.status === 200 && bodyNo.computed === false && bodyNo.reason === "no_payout_config");
    const { data: scNo } = await admin.from("league_scores").select("money_delta").eq("league_round_id", roundIdNoConfig);
    ok("money_delta remains NULL when not computed", scNo?.every((s) => s.money_delta == null));
  }
  await admin.from("groups").update({ dollars_per_point: 1 }).eq("id", GROUP_POINTS);
  const rPayoutRound = await ingest(token, {
    group_id: GROUP_POINTS,
    season_id: SEASON_POINTS,
    round_date: "2025-06-19",
    source_app: "domain-test",
    external_event_id: "domain-payout-with-config",
    scores: [
      { player_id: "player-1", score_value: 2 },
      { player_id: "player-2", score_value: -2 },
    ],
  });
  const roundIdConfig = rPayoutRound.league_round_id;
  if (roundIdConfig) {
    const rComp = await fetch(`${FUNCTIONS}/compute-money-deltas`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ league_round_id: roundIdConfig }),
    });
    const bodyComp = await rComp.json().catch(() => ({}));
    ok("With dollars_per_point set → computed: true", rComp.status === 200 && bodyComp.computed === true && bodyComp.updated === 2);
    const { data: sc } = await admin.from("league_scores").select("money_delta").eq("league_round_id", roundIdConfig);
    const sum = (sc ?? []).reduce((s, r) => s + (r.money_delta ?? 0), 0);
    ok("Zero-sum after compute", sum === 0);
  }

  console.log("\n--- 11. generate-payment-requests: two-player, multi-player, all zeros, NULL, non-zero-sum, deterministic ---");
  async function generatePaymentRequests(token, leagueRoundId) {
    const r = await fetch(`${FUNCTIONS}/generate-payment-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ league_round_id: leagueRoundId }),
    });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, ...body };
  }
  if (roundIdConfig) {
    const gen = await generatePaymentRequests(token, roundIdConfig);
    ok("generate-payment-requests two-player (2, -2 → one request 200 cents)", gen.status === 200 && gen.requests?.length === 1 && gen.requests[0].amount_cents === 200);
    const gen2 = await generatePaymentRequests(token, roundIdConfig);
    ok("generate-payment-requests deterministic", gen.status === 200 && JSON.stringify(gen.requests) === JSON.stringify(gen2.requests));
  }
  const insertRes = await admin.from("group_members").insert(
    { id: "gm-pay3", group_id: GROUP_POINTS, player_id: "player-3", role: "member", is_active: 1, joined_at: new Date().toISOString() }
  ).select();
  const hasPlayer3 = !insertRes.error || insertRes.error?.code === "23505";
  if (hasPlayer3) {
    const rMulti = await ingest(token, {
      group_id: GROUP_POINTS,
      season_id: SEASON_POINTS,
      round_date: "2025-06-21",
      source_app: "domain-test",
      external_event_id: "domain-payment-multi",
      scores: [
        { player_id: "player-1", score_value: 3 },
        { player_id: "player-2", score_value: -1 },
        { player_id: "player-3", score_value: -2 },
      ],
    });
    if (rMulti.status === 201 && rMulti.league_round_id) {
      await fetch(`${FUNCTIONS}/compute-money-deltas`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ league_round_id: rMulti.league_round_id }),
      });
      const genMulti = await generatePaymentRequests(token, rMulti.league_round_id);
      const reqs = genMulti.requests ?? [];
      ok("generate-payment-requests multi-player (3 players) → 2 requests", genMulti.status === 200 && reqs.length === 2);
      const totalCents = reqs.reduce((s, r) => s + r.amount_cents, 0);
      ok("multi-player request amounts sum to 300 cents", totalCents === 300);
    }
  }
  if (roundIdNoConfig) {
    const genNull = await generatePaymentRequests(token, roundIdNoConfig);
    ok("generate-payment-requests NULL money_delta → 400 money_delta_not_computed", genNull.status === 400 && genNull.code === "money_delta_not_computed");
  }
  const roundAllZeros = await ingest(token, {
    group_id: GROUP_POINTS,
    season_id: SEASON_POINTS,
    round_date: "2025-06-20",
    source_app: "domain-test",
    external_event_id: "domain-payment-all-zeros",
    scores: [
      { player_id: "player-1", score_value: 0 },
      { player_id: "player-2", score_value: 0 },
    ],
  });
  if (roundAllZeros.league_round_id) {
    await fetch(`${FUNCTIONS}/compute-money-deltas`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ league_round_id: roundAllZeros.league_round_id }),
    });
    const genZero = await generatePaymentRequests(token, roundAllZeros.league_round_id);
    ok("generate-payment-requests all zero deltas → empty requests", genZero.status === 200 && Array.isArray(genZero.requests) && genZero.requests.length === 0);
  }
  if (roundIdConfig) {
    const { data: oneScore } = await admin.from("league_scores").select("id").eq("league_round_id", roundIdConfig).eq("player_id", "player-1").limit(1);
    if (oneScore?.length) {
      await admin.from("league_scores").update({ money_delta: 1.5 }).eq("id", oneScore[0].id);
      const genBad = await generatePaymentRequests(token, roundIdConfig);
      ok("generate-payment-requests non-zero-sum → 400 round_not_zero_sum", genBad.status === 400 && genBad.code === "round_not_zero_sum");
      await admin.from("league_scores").update({ money_delta: 2 }).eq("id", oneScore[0].id);
    }
  }

  console.log("\n--- Summary ---");
  console.log(passed + " passed, " + failed + " failed.");
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
