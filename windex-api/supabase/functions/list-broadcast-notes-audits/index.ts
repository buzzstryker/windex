// GET /list-broadcast-notes-audits — last 10 broadcast_notes_log rows for the
// super-admin audit UI in windex-admin.
//
// Auth: caller must be a super admin (am_i_super_admin, migration 014). 401 if
// no/invalid JWT, 403 if not a super admin. Mirrors the create-group gate.
//
// Returns a compact, display-ready shape. Per-row claim stats are computed from
// fact_check_audit->'annotations' (migration 033). fact_check_status:
//   "none"  — fact_check_audit IS NULL (generation predating the fact-check
//             feature, or aborted before stage 2).
//   "error" — fact-check ran but hard-failed (audit carries an `error` field;
//             annotations is typically empty).
//   "ok"    — fact-check completed; counts reflect the annotations.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type Annotation = { id?: string; status?: string; correction?: string; reasoning?: string };
type FactCheckAudit = { annotations?: Annotation[]; error?: string } | null;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing authorization" }, 401);
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "Missing Bearer token" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Caller-context client (anon key + caller JWT) for identity + the gate.
  const caller = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userInfo, error: userErr } = await caller.auth.getUser(token);
  if (userErr || !userInfo?.user?.id) {
    return json({ error: "Unauthorized", msg: userErr?.message ?? "Invalid JWT" }, 401);
  }

  // Super-admin gate via SQL helper from migration 014.
  const { data: isSuper, error: gateErr } = await caller.rpc("am_i_super_admin");
  if (gateErr) return json({ error: "Permission check failed", details: gateErr.message }, 500);
  if (isSuper !== true) return json({ error: "Super admin only" }, 403);

  // Read with service role (RLS-exempt) now that the caller is verified super
  // admin — avoids depending on join-time RLS for the group name.
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: rows, error: qErr } = await admin
    .from("broadcast_notes_log")
    .select("id, created_at, group_id, spotlight_names, fact_check_audit, groups(name)")
    .order("created_at", { ascending: false })
    .limit(10);
  if (qErr) return json({ error: "Failed to load audit rows", details: qErr.message }, 500);

  const out = (rows ?? []).map((r: {
    id: string;
    created_at: string;
    group_id: string;
    spotlight_names: string[] | null;
    fact_check_audit: FactCheckAudit;
    groups: { name: string } | { name: string }[] | null;
  }) => {
    const fca = r.fact_check_audit;
    const annotations = Array.isArray(fca?.annotations) ? fca!.annotations! : [];
    const total_claims = annotations.length;
    const wrong_count = annotations.filter((a) => a.status === "wrong").length;
    const ambiguous_count = annotations.filter((a) => a.status === "ambiguous").length;
    const fact_check_status: "none" | "error" | "ok" =
      fca == null ? "none" : (typeof fca.error === "string" && fca.error ? "error" : "ok");
    // PostgREST embeds may surface as object or single-element array.
    const grp = Array.isArray(r.groups) ? r.groups[0] : r.groups;
    return {
      id: r.id,
      created_at: r.created_at,
      group_name: grp?.name ?? null,
      spotlight_names: r.spotlight_names ?? [],
      total_claims,
      wrong_count,
      ambiguous_count,
      fact_check_status,
    };
  });

  return json({ rows: out }, 200);
});
