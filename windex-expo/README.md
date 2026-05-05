# windex-expo

Expo app for Late Add Golf v2 — web (Vercel), iOS, and Android via Expo Go.

## Web deployment

- **Production:** https://windexgolf.com (Vercel, auto-deploys from `master`). `app.lateaddgolf.com` 308-redirects here for legacy bookmarks.
- **Vercel root directory:** `windex-expo/`
- **Build:** `npx expo export --platform web` → outputs to `dist/`

## Authentication

Login uses **email OTP** (6-digit code):

1. User enters their email on the login screen
2. Taps "Send Login Code" → Supabase sends a 6-digit code to their email
3. User enters the code → `supabase.auth.verifyOtp()` establishes the session
4. No redirects, no magic links, no PKCE — works identically on web and mobile

**Email/password** fallback is available behind a "Sign in with password instead" toggle (used for dev accounts).

Only existing users can log in (`shouldCreateUser: false`). Player accounts are created by an admin via `windex-api/scripts/invite-players.mjs`.

### Auth architecture

- **AuthContext** (`contexts/AuthContext.tsx`): `onAuthStateChange` is the single source of truth for `signedIn` and `ready` state. Exposes `sendOtp`, `verifyOtp`, `signInWithPassword`, `signOut`.
- **Session storage**: `lib/authPersistence.ts` — uses `localStorage` on web, `expo-file-system` on native.
- **401 handling**: API calls that return 401 trigger automatic sign-out (with a 30-second grace period after fresh login to avoid stale in-flight requests).
- **Routing**: `_layout.tsx` redirects to `/login` when `signedIn=false` and to `/(tabs)/standings` when `signedIn=true`.

## Environment variables

Copy `.env.example` to `.env`:

```
EXPO_PUBLIC_SUPABASE_URL=https://ftmqzxykwcccocogkjhc.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your_publishable_key
EXPO_PUBLIC_LATE_ADD_API_URL=https://ftmqzxykwcccocogkjhc.supabase.co/functions/v1
```

For Vercel, set these in the Vercel dashboard under Settings > Environment Variables.

## Development

```bash
cd windex-expo
npm install
npx expo start        # dev server (web + mobile)
npx expo start --web  # web only
```

### Mobile (Expo Go on iPhone / iPad)

```bash
npm run start:tunnel   # works from Windows PC to iOS device
```

Scan the QR code with the Camera app, opens in Expo Go.

**LAN alternative** (same Wi-Fi required):
```bash
npm run start:lan
```

### PWA / Add to Home Screen

The web deployment includes:
- `public/manifest.json` with PWA metadata
- `public/apple-touch-icon.png` (180x180) for iOS home screen icon
- `app/+html.tsx` with manifest and apple-touch-icon head tags

To get the app icon on iPhone: Safari > Share > Add to Home Screen.

## Supabase configuration

### Auth settings (pushed via `supabase config push`)
- **Site URL:** `https://windexgolf.com`
- **Redirect URLs:** `https://windexgolf.com`, `https://windexgolf.com/**`, `https://www.windexgolf.com`, `https://www.windexgolf.com/**`, `https://late-add-v2.vercel.app`, `https://late-add-v2.vercel.app/**` (the `late-add-v2.vercel.app` entries track the Vercel project name and will be revisited when the Vercel project is renamed)
- **OTP:** 6 digits, 1-hour expiry
- **Email template:** Custom OTP-only template (shows code, no magic link)

### Edge Functions
All Edge Functions are deployed with `--no-verify-jwt`. Functions handle auth internally via `getUser(token)`. See `windex-api/supabase/config.toml` for the full list.

## Project structure

```
windex-expo/
├── app/              # Expo Router screens (file-based routing)
│   ├── (tabs)/       # Tab screens: standings, rounds, history, etc.
│   ├── login.tsx     # OTP + password login
│   ├── _layout.tsx   # Root layout with auth routing
│   └── +html.tsx     # Custom HTML head (PWA, icons)
├── components/       # Shared UI components
├── contexts/         # AuthContext, GroupContext, DrawerContext
├── lib/              # API client, config, auth persistence
├── constants/        # Theme colors
├── hooks/            # Custom hooks
├── public/           # Static assets (manifest, icons)
└── assets/           # Images and fonts
```
