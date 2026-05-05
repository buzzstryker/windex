# Windex Admin UI

Standalone admin web app for Windex: Dashboard, Rounds, Round Entry, Round Edit, Standings, Groups, Players, Points Analysis, Attribution Review, Player Mapping. Built with Vite + React + TypeScript + React Router.

**Testing order:** Validate features here in the **web admin UI first**; then repeat checks on **iPad / iPhone** via `late-add-expo/` (see parent [README.md](../README.md#recommended-testing-order)).

- **Docs:** See the parent folder (this Windex directory) for product and API docs (README.md and linked .md files).
- **API:** Talks to **late-add-api** (Supabase Cloud Edge Functions). Default: `https://ftmqzxykwcccocogkjhc.supabase.co/functions/v1`. Set `VITE_LATE_ADD_API_URL` in `.env.local` to override.

## First-time setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Create `.env.local`** (if it doesn't exist):
   ```bash
   cp .env.example .env.local
   ```
   Defaults point to Supabase Cloud (`ftmqzxykwcccocogkjhc`). No edits needed for normal dev.

3. **Ensure backend is deployed** (from `late-add-api/`):
   ```bash
   cd ../late-add-api
   supabase login --token <your-access-token>
   supabase link --project-ref ftmqzxykwcccocogkjhc
   supabase db push          # apply migrations
   supabase functions deploy --no-verify-jwt   # deploy Edge Functions
   ```
   The `--no-verify-jwt` flag is required because the functions handle auth internally via `getUser()`.

4. **Create a test user** (one-time — skip if `dev@lateaddgolf.com` already exists):
   - Email confirmation must be **disabled** in the Supabase Dashboard: Settings > Authentication > "Confirm email" = off.
   - Sign up via API:
     ```bash
     curl -s "https://ftmqzxykwcccocogkjhc.supabase.co/auth/v1/signup" \
       -H "apikey: sb_publishable_4S2RA8nlnCEM9jE1i7_8_g_m-lU7YnH" \
       -H "Content-Type: application/json" \
       -d '{"email":"dev@lateaddgolf.com","password":"testpass123"}'
     ```

## Run (each session)

```bash
npm run dev
```

Open http://localhost:3001 (or the port Vite shows if 3001 is in use).

## Auth (getting a JWT)

The login screen accepts a Supabase JWT. JWTs expire after **1 hour**. To get a fresh one each session:

```bash
curl -s "https://ftmqzxykwcccocogkjhc.supabase.co/auth/v1/token?grant_type=password" \
  -H "apikey: sb_publishable_4S2RA8nlnCEM9jE1i7_8_g_m-lU7YnH" \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@lateaddgolf.com","password":"testpass123"}'
```

Copy the `access_token` value from the response, paste it into the login screen, and click **Sign in**.

Alternatively, click **"Continue without token"** — the anon key will be used automatically, but API calls that require user-scoped RLS will return empty results.

## Build

```bash
npm run build
npm run preview   # serve dist/
```
