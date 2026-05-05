# windex-api

API for Late Add Golf v2: points-ingestion and standings. Groups, seasons, league rounds, scores, and standings. Windex does not compute golf competition formats; it accepts final point totals and stores/aggregates them. Backed by Supabase (Postgres, Auth, Edge Functions).

## Prerequisites

- Node 18+
- [Supabase CLI](https://supabase.com/docs/guides/cli)
- A Supabase project (create at supabase.com)

## Setup

1. From the Windex directory, go into the API folder and install:

   ```bash
   cd windex-api
   npm install
   ```

2. Link Supabase project and run migrations:

   ```bash
   cp .env.example .env
   # Edit .env: SUPABASE_URL, SUPABASE_ANON_KEY (SERVICE_ROLE_KEY for admin if needed)
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```

## Development (Supabase Cloud)

We use **Supabase Cloud exclusively** — no local Supabase (`supabase start` is not used).

- **API base:** `https://ftmqzxykwcccocogkjhc.supabase.co/functions/v1/`
- **Seed user:** `test@lateadd.local` / `testpass123` (for integration tests).

After linking and pushing migrations, deploy functions:

```bash
supabase functions deploy
```

## Tests

**Smoke (no Supabase required):** request validation and auth checks

```bash
npm run test:local
```

**Integration (full happy path):** requires deployed functions on Supabase Cloud. Uses seed user and asserts ingest → league_rounds, league_scores, season_standings, idempotency, and invalid-player rejection.

**Domain rules:** `npm run test:domain` — asserts business rules: points only (stroke-like values rejected), season-group match, membership, idempotency, override metadata, win_loss_override, multi-group, standings from event results.

**Adapter ingest:** `npm run test:adapter` — loads fixture from `tests/fixtures/external-round.json`, normalizes via `adapters/normalize.mjs`, POSTs to ingest-event-results, and verifies league_rounds, league_scores, player_mapping_queue, and standings. Requires deployed functions on Supabase Cloud (same as integration test). See `docs/SOURCE_ADAPTERS.md`.

1. Ensure functions are deployed to Supabase Cloud: `supabase functions deploy`.
2. Copy `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` from the Supabase Dashboard into `.env` (or export them).
3. Run:

```bash
npm install
npm run test:integration
```

## Deploy

```bash
supabase db push
supabase functions deploy --no-verify-jwt
supabase config push                        # pushes auth config (OTP template, redirect URLs)
```

The `--no-verify-jwt` flag is required — all functions handle auth internally via `getUser(token)`. Platform-level JWT verification uses different keys when linked to a remote project and rejects valid tokens.

### Player accounts

Player auth accounts are created via `scripts/invite-players.mjs`:

```bash
node scripts/invite-players.mjs                  # dry run — shows player list
node scripts/invite-players.mjs --send-invites   # creates accounts + links players.user_id
```

This creates Supabase auth accounts for players with emails in specified groups, sends invite emails, and updates `players.user_id` to link each player to their auth account.

## Glide ODS import

To import a Glide app export (`.ods`) into Windex:

1. **Convert** the ODS to ingest payloads (use your Windex group and season IDs):
   ```bash
   node scripts/convert-glide-ods-to-ingest.mjs "path/to/f35a60.Late Add Golf.ods" --group-id=group-seed-001 --season-id=season-seed-001
   ```
2. **Import** (with functions deployed and auth in env):
   ```bash
   node scripts/run-glide-import.mjs
   ```
   See `docs/SOURCE_ADAPTERS.md` (Glide ODS import) for details. Unresolved players go to the player-mapping queue.

## Docs

- Schema and bootstrap: `docs/`
- Parent Windex directory: `../` (bootstrap plan, data model, API spec at root)

