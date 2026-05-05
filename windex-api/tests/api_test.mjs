// Local API tests. Run with: node tests/api_test.mjs
// Requires local Supabase: supabase start && supabase functions serve

const BASE = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const FUNCTIONS = `${BASE}/functions/v1`;

function ok(name, cond, detail = "") {
  console.log(cond ? `  OK   ${name}` : `  FAIL ${name}` + (detail ? ` — ${detail}` : ""));
  return cond;
}

async function runTests() {
  console.log("Windex backend — local API tests\n");
  let passed = 0;
  let failed = 0;

  // GET get-standings: no auth → 401
  try {
    const r1 = await fetch(`${FUNCTIONS}/get-standings`);
    if (ok("get-standings without auth → 401", r1.status === 401, `got ${r1.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("get-standings (reachable)", false, String(e))) passed++; else failed++;
  }

  // GET get-standings: with season_id but no auth → 401
  try {
    const r2 = await fetch(`${FUNCTIONS}/get-standings?season_id=00000000-0000-0000-0000-000000000001`);
    if (ok("get-standings without auth (with season_id) → 401", r2.status === 401, `got ${r2.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("get-standings auth check (reachable)", false, String(e))) passed++; else failed++;
  }

  // POST ingest-event-results: no auth, empty body → 401 (auth first) or 400
  try {
    const r3 = await fetch(`${FUNCTIONS}/ingest-event-results`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const valid = r3.status === 400 || r3.status === 401;
    if (ok("ingest-event-results empty body → 400 or 401", valid, `got ${r3.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("ingest-event-results (reachable)", false, String(e))) passed++; else failed++;
  }

  // POST ingest-event-results: invalid body (missing round_date, scores) → 400 or 401
  try {
    const r4 = await fetch(`${FUNCTIONS}/ingest-event-results`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: "g1" }),
    });
    const valid = r4.status === 400 || r4.status === 401;
    if (ok("ingest-event-results invalid body → 400 or 401", valid, `got ${r4.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("ingest-event-results validation (reachable)", false, String(e))) passed++; else failed++;
  }

  // GET /review/player-mapping without auth → 401
  try {
    const r5 = await fetch(`${FUNCTIONS}/review/player-mapping`, { method: "GET" });
    if (ok("review/player-mapping without auth → 401", r5.status === 401, `got ${r5.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("review/player-mapping (reachable)", false, String(e))) passed++; else failed++;
  }

  // POST /review/player-mapping/:id/resolve without auth → 401
  try {
    const r6 = await fetch(`${FUNCTIONS}/review/player-mapping/a1000000-0000-0000-0000-000000000001/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ player_id: "player-1" }),
    });
    if (ok("review/player-mapping/:id/resolve without auth → 401", r6.status === 401, `got ${r6.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("review/player-mapping resolve (reachable)", false, String(e))) passed++; else failed++;
  }

  // GET /review/attribution without auth → 401
  try {
    const r7 = await fetch(`${FUNCTIONS}/review/attribution`, { method: "GET" });
    if (ok("review/attribution without auth → 401", r7.status === 401, `got ${r7.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("review/attribution (reachable)", false, String(e))) passed++; else failed++;
  }

  // POST /review/attribution/:id/resolve without auth → 401
  try {
    const r8 = await fetch(`${FUNCTIONS}/review/attribution/00000000-0000-0000-0000-000000000001/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: "group-seed-001", season_id: "season-seed-001" }),
    });
    if (ok("review/attribution/:id/resolve without auth → 401", r8.status === 401, `got ${r8.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("review/attribution resolve (reachable)", false, String(e))) passed++; else failed++;
  }

  // GET /standings-player-history without auth → 401
  try {
    const r9 = await fetch(
      `${FUNCTIONS}/standings-player-history?group_id=group-seed-001&season_id=season-seed-001&player_id=player-1`,
      { method: "GET" }
    );
    if (ok("standings-player-history without auth → 401", r9.status === 401, `got ${r9.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("standings-player-history (reachable)", false, String(e))) passed++; else failed++;
  }

  console.log("\n" + (failed === 0 ? "All checks passed." : `${failed} check(s) failed.`));
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
