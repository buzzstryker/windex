# late-add-api repo bootstrap plan

Based on this Windex directory (Windex is a separate app from Scorekeeper). The **late-add-api** code and Supabase backend live in **`late-add-api/`** in this directory.

---

## 1. Recommended folder structure

```
late-add-api/
├── supabase/
│   ├── migrations/          # timestamped SQL migrations (see below)
│   └── functions/           # Edge Functions (see first endpoints)
├── src/
│   ├── lib/                 # supabase client, env, helpers
│   ├── services/            # business logic (group, season, league)
│   └── types/               # local types until shared-golf-types exists
├── docs/                    # API spec, runbooks
├── package.json
├── tsconfig.json
└── README.md
```

- **supabase/migrations/** — One file per change; run in order by timestamp.
- **supabase/functions/** — One folder per function (e.g. `health`, `groups-list`).
- **src/lib/** — `supabase.ts` (createClient), `env.ts` (validate env).
- **src/services/** — Call Supabase from handlers; keep logic here, not in function bodies.
- **src/types/** — Interfaces for request/response and DB rows; migrate to shared-golf-types later.

---

## 2. Supabase migration structure

- **Naming:** `YYYYMMDDHHMMSS_short_description.sql` (e.g. `20250108120000_initial_schema.sql`).
- **Order:** Supabase applies migrations in lexicographic order; timestamps define sequence.
- **Content:** One logical change per file (schema only, or schema + indexes). Put RLS in a dedicated migration after tables exist.
- **Idempotency:** Prefer `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` where safe; avoid `DROP` in early migrations.

---

## 3. First three migration files to create

### Migration 1: `20250108120000_initial_schema.sql`

Core league/group tables the API will use first. Assumes `auth.users` exists (Supabase default).

```sql
-- Extensions (if needed)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Sections (optional parent for groups)
CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Groups (Windex leagues)
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  logo_url TEXT,
  section_id TEXT REFERENCES sections(id) ON DELETE SET NULL,
  admin_player_id TEXT,
  season_start_month INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Group members
CREATE TABLE IF NOT EXISTS group_members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  is_active SMALLINT NOT NULL DEFAULT 1,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, player_id)
);

-- Seasons
CREATE TABLE IF NOT EXISTS seasons (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_groups_user ON groups(user_id);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_seasons_group ON seasons(group_id);
```

### Migration 2: `20250108120001_league_rounds_scores.sql`

League rounds and scores so the API can serve standings and submit round data.

```sql
CREATE TABLE IF NOT EXISTS league_rounds (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  season_id TEXT REFERENCES seasons(id) ON DELETE SET NULL,
  round_id TEXT,
  round_date TEXT NOT NULL,
  submitted_at TEXT,
  scores_override SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS league_scores (
  id TEXT PRIMARY KEY,
  league_round_id TEXT NOT NULL REFERENCES league_rounds(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  score_value DOUBLE PRECISION,
  score_override DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(league_round_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_league_rounds_group ON league_rounds(group_id);
CREATE INDEX IF NOT EXISTS idx_league_rounds_season ON league_rounds(season_id);
CREATE INDEX IF NOT EXISTS idx_league_scores_round ON league_scores(league_round_id);
```

### Migration 3: `20250108120002_rls_policies.sql`

Row Level Security so only the owning user can access their data.

```sql
ALTER TABLE sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE league_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE league_scores ENABLE ROW LEVEL SECURITY;

-- Example: groups (repeat pattern for other tables as needed)
CREATE POLICY "select_own_groups" ON groups FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "insert_own_groups" ON groups FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update_own_groups" ON groups FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "delete_own_groups" ON groups FOR DELETE USING (auth.uid() = user_id);

-- group_members: allow if user owns the group
CREATE POLICY "select_group_members" ON group_members FOR SELECT
  USING (EXISTS (SELECT 1 FROM groups g WHERE g.id = group_members.group_id AND g.user_id = auth.uid()));
CREATE POLICY "insert_group_members" ON group_members FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM groups g WHERE g.id = group_members.group_id AND g.user_id = auth.uid()));
CREATE POLICY "update_group_members" ON group_members FOR UPDATE
  USING (EXISTS (SELECT 1 FROM groups g WHERE g.id = group_members.group_id AND g.user_id = auth.uid()));
CREATE POLICY "delete_group_members" ON group_members FOR DELETE
  USING (EXISTS (SELECT 1 FROM groups g WHERE g.id = group_members.group_id AND g.user_id = auth.uid()));

-- seasons, league_rounds, league_scores: same idea (user owns group → can access)
-- Add policies for sections, seasons, league_rounds, league_scores following the same pattern.
```

(Complete RLS for `sections`, `seasons`, `league_rounds`, and `league_scores` using either `user_id` or group ownership as above.)

---

## 4. First API endpoints / functions to implement

Implement as **Supabase Edge Functions** under `supabase/functions/`, each with its own folder and `index.ts`.

| Function      | Method | Purpose |
|---------------|--------|---------|
| **health**    | GET    | No auth. Return `{ ok: true }` for load balancer and dev sanity check. |
| **groups-list** | GET  | Auth required. List groups for `auth.uid()`; query `groups` with RLS. |
| **group-by-id** | GET  | Auth required. Get one group by id; return group + members + seasons (or separate calls). |
| **seasons-by-group** | GET | Auth required. List seasons for a given `group_id`; RLS enforces access. |

Implementation notes:

- In each function: parse request, validate, call a **service** in `src/services/` that uses the Supabase client (with the request’s JWT for RLS).
- Return JSON and appropriate status codes (200, 401, 404).
- Keep handlers thin; put validation and DB logic in `src/services/`.

---

## 5. What should move later into shared-golf-types

Move these out of **late-add-api** into **shared-golf-types** (e.g. `src/late-add/` and `src/scorekeeper/`) so both the app and API consume the same definitions:

- **Windex / league:** `Section`, `Group`, `GroupMember`, `Season`, `LeagueRound`, `LeagueScore` (and create/update DTOs).
- **Enums:** Group member role (`member` | `admin`), round type, handicap mode, league round `scores_override` flag.
- **Other golf apps (for sync/compat):** Minimal `Player` (id, name, handicap_index, ghin_number), `Course`, `Round`, `Score` — at least the fields a source app or sync layer might use.

Start with types in **late-add-api** `src/types/`; once shared-golf-types exists, re-export from the package and delete local duplicates.

---

## 6. Minimal README for late-add-api

Use this as the initial **README.md** in the late-add-api repo:

```markdown
# late-add-api

API for Late Add Golf: groups, seasons, league rounds, and scores. Backed by Supabase (Postgres + Auth + Edge Functions).

## Prerequisites

- Node 18+
- [Supabase CLI](https://supabase.com/docs/guides/cli)
- A Supabase project (create at supabase.com)

## Setup

1. Clone and install:
   ```bash
   git clone <repo-url> late-add-api && cd late-add-api
   npm install
   ```

2. Copy env and link project:
   ```bash
   cp .env.example .env
   # Edit .env: SUPABASE_URL, SUPABASE_ANON_KEY (and SERVICE_ROLE_KEY for scripts if needed)
   supabase link --project-ref <your-project-ref>
   ```

3. Run migrations:
   ```bash
   supabase db push
   ```

## Development (Supabase Cloud)

We use **Supabase Cloud exclusively** (no local Supabase).

- Push migrations: `supabase db push`
- Deploy functions: `supabase functions deploy`
- API base: `https://ftmqzxykwcccocogkjhc.supabase.co/functions/v1/`

## Docs

- API and behavior: see `docs/`
- Schema and bootstrap: see this Windex directory (bootstrap plan, migrations, shared-golf-types).
```

---

## Summary

| Item | Action |
|------|--------|
| **Folder structure** | Use the tree in §1; add `package.json`, `tsconfig.json`, `.env.example`. |
| **Migrations** | Timestamped files in `supabase/migrations/`; first three: initial schema (sections, groups, members, seasons), league_rounds + league_scores, RLS. |
| **First endpoints** | Edge Functions: `health`, `groups-list`, `group-by-id`, `seasons-by-group`. |
| **Types** | Start in `src/types/`; move Section, Group, Season, LeagueRound, LeagueScore, and shared enums to **shared-golf-types** when that package exists. |
| **README** | Use the minimal README in §6; link to this bootstrap plan and this Windex directory. |
