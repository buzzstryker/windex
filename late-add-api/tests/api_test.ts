// Local API tests. Run with: deno test tests/api_test.ts --allow-net
// Requires local Supabase: supabase start

const BASE = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const FUNCTIONS = `${BASE}/functions/v1`;

function ok(name: string, cond: boolean, detail?: string) {
  console.log(cond ? `  OK   ${name}` : `  FAIL ${name}` + (detail ? ` — ${detail}` : ""));
  return cond;
}

async function runTests() {
  console.log("Windex backend — local API tests\n");
  let passed = 0;
  let failed = 0;

  // GET get-standings: missing season_id → 400
  try {
    const r1 = await fetch(`${FUNCTIONS}/get-standings`, { method: "GET" });
    const b1 = await r1.json().catch(() => ({}));
    if (ok("get-standings without season_id → 400", r1.status === 400, `got ${r1.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("get-standings (reachable)", false, String(e))) passed++; else failed++;
  }

  // GET get-standings: with season_id but no auth → 401
  try {
    const r2 = await fetch(`${FUNCTIONS}/get-standings?season_id=00000000-0000-0000-0000-000000000001`, { method: "GET" });
    if (ok("get-standings without auth → 401", r2.status === 401, `got ${r2.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("get-standings auth check (reachable)", false, String(e))) passed++; else failed++;
  }

  // POST ingest-event-results: no body → 400
  try {
    const r3 = await fetch(`${FUNCTIONS}/ingest-event-results`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const b3 = await r3.json().catch(() => ({}));
    const hasError = r3.status === 400 && (b3?.error != null || r3.status === 400);
    if (ok("ingest-event-results empty body → 400", r3.status === 400, `got ${r3.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("ingest-event-results (reachable)", false, String(e))) passed++; else failed++;
  }

  // POST ingest-event-results: invalid body (missing group_id, round_date, scores) → 400
  try {
    const r4 = await fetch(`${FUNCTIONS}/ingest-event-results`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: "g1" }),
    });
    if (ok("ingest-event-results invalid body → 400", r4.status === 400, `got ${r4.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("ingest-event-results validation (reachable)", false, String(e))) passed++; else failed++;
  }

  // GET /groups without auth → 401
  try {
    const r5 = await fetch(`${FUNCTIONS}/groups`, { method: "GET" });
    if (ok("groups without auth → 401", r5.status === 401, `got ${r5.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("groups (reachable)", false, String(e))) passed++; else failed++;
  }

  // GET /seasons without auth → 401
  try {
    const r6 = await fetch(`${FUNCTIONS}/seasons`, { method: "GET" });
    if (ok("seasons without auth → 401", r6.status === 401, `got ${r6.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("seasons (reachable)", false, String(e))) passed++; else failed++;
  }

  // GET /events without auth → 401
  try {
    const r7 = await fetch(`${FUNCTIONS}/events`, { method: "GET" });
    if (ok("events without auth → 401", r7.status === 401, `got ${r7.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("events (reachable)", false, String(e))) passed++; else failed++;
  }

  // GET /events/:id without auth → 401
  try {
    const r8 = await fetch(`${FUNCTIONS}/events/00000000-0000-0000-0000-000000000001`, { method: "GET" });
    if (ok("events/:id without auth → 401", r8.status === 401, `got ${r8.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("events/:id (reachable)", false, String(e))) passed++; else failed++;
  }

  // PATCH /events/:id without auth → 401
  try {
    const r9 = await fetch(`${FUNCTIONS}/events/00000000-0000-0000-0000-000000000001`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ round_date: "2025-01-15" }),
    });
    if (ok("PATCH events/:id without auth → 401", r9.status === 401, `got ${r9.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("PATCH events/:id (reachable)", false, String(e))) passed++; else failed++;
  }

  // GET /players without auth → 401
  try {
    const r10 = await fetch(`${FUNCTIONS}/players`, { method: "GET" });
    if (ok("players without auth → 401", r10.status === 401, `got ${r10.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("players (reachable)", false, String(e))) passed++; else failed++;
  }

  // GET /players?group_id= without auth → 401
  try {
    const r11 = await fetch(`${FUNCTIONS}/players?group_id=group-seed-001`, { method: "GET" });
    if (ok("players?group_id= without auth → 401", r11.status === 401, `got ${r11.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("players?group_id= (reachable)", false, String(e))) passed++; else failed++;
  }

  // GET /review/player-mapping without auth → 401
  try {
    const r12 = await fetch(`${FUNCTIONS}/review/player-mapping`, { method: "GET" });
    if (ok("review/player-mapping without auth → 401", r12.status === 401, `got ${r12.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("review/player-mapping (reachable)", false, String(e))) passed++; else failed++;
  }

  // POST /review/player-mapping/:id/resolve without auth → 401
  try {
    const r13 = await fetch(`${FUNCTIONS}/review/player-mapping/a1000000-0000-0000-0000-000000000001/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ player_id: "player-1" }),
    });
    if (ok("review/player-mapping/:id/resolve without auth → 401", r13.status === 401, `got ${r13.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("review/player-mapping resolve (reachable)", false, String(e))) passed++; else failed++;
  }

  // GET /review/attribution without auth → 401
  try {
    const r14 = await fetch(`${FUNCTIONS}/review/attribution`, { method: "GET" });
    if (ok("review/attribution without auth → 401", r14.status === 401, `got ${r14.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("review/attribution (reachable)", false, String(e))) passed++; else failed++;
  }

  // POST /review/attribution/:id/resolve without auth → 401
  try {
    const r15 = await fetch(`${FUNCTIONS}/review/attribution/00000000-0000-0000-0000-000000000001/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: "group-seed-001", season_id: "season-seed-001" }),
    });
    if (ok("review/attribution/:id/resolve without auth → 401", r15.status === 401, `got ${r15.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("review/attribution resolve (reachable)", false, String(e))) passed++; else failed++;
  }

  // GET /standings-player-history without auth → 401
  try {
    const r16 = await fetch(
      `${FUNCTIONS}/standings-player-history?group_id=group-seed-001&season_id=season-seed-001&player_id=player-1`,
      { method: "GET" }
    );
    if (ok("standings-player-history without auth → 401", r16.status === 401, `got ${r16.status}`)) passed++; else failed++;
  } catch (e) {
    if (ok("standings-player-history (reachable)", false, String(e))) passed++; else failed++;
  }

  console.log("\n" + (failed === 0 ? "All checks passed." : `${failed} check(s) failed.`));
  Deno.exit(failed > 0 ? 1 : 0);
}

runTests();
