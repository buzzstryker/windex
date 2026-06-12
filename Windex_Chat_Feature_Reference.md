# Windex Chat Feature Reference

> Complete technical reference for the Windex chat/messaging feature (including photo upload), written for porting into another React Native/Expo PWA + Supabase + Vercel project. The reader is assumed to have **zero access** to the Windex codebase. Generated 2026-06-11.

**Provenance:** every SQL block in this document is copied **verbatim from the version-controlled migration files** (`windex-api/supabase/migrations/014, 040–045`) and every code excerpt/behavior description from the actual source files listed in §6.1 — nothing is reconstructed from memory. Where Windex's deployed database could theoretically drift from its migrations, that is flagged inline (see §10).

**Stack context:** Expo (~54) / expo-router / react-native-web PWA deployed on Vercel; Supabase Postgres + Auth + Storage + Realtime. The app's data layer is **raw PostgREST `fetch` calls** (no supabase-js query builder); supabase-js is used **only** for auth (one client) and realtime (a second, session-less client). There are **no chat-specific Edge Functions and no chat-specific SECURITY DEFINER RPCs** — chat is direct table access governed entirely by RLS, plus three pre-existing SECURITY DEFINER helper functions used inside the policies.

---

## 1. Data Model

### 1.1 Identity model (how messages relate to users)

Chat does **not** reference `auth.uid()` directly. Windex has a `players` table (its equivalent of Honcut's `user_profiles`) and messages are authored **by a player**, not by an auth user:

- `players.id TEXT PRIMARY KEY` — globally unique app-level id (nanoid-style 20-char strings; historically Glide row IDs).
- `players.user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL` — link to the auth user. Nullable because admins can pre-create players before the invite is accepted.
- One auth user **may own multiple player rows**. The client resolves a single deterministic "author identity": the *earliest-created* player row for the signed-in user (see `lib/chatAuthor.ts`, §6.3). RLS, by contrast, accepts *any* of the user's player ids (via `get_my_player_ids()`).
- Relevant `players` columns used by chat: `id`, `user_id`, `display_name TEXT NOT NULL`, `full_name TEXT NULL`, `is_super_admin SMALLINT NOT NULL DEFAULT 0`, `created_at TIMESTAMPTZ`.
- `players` SELECT policy is `USING (true)` for `authenticated` — this is what lets the chat screen resolve any author id to a display name with a plain PostgREST read. **If your profile table is not world-readable to authenticated users, name resolution needs an alternative path.**

Group context (used only by the schema's dormant per-group-room support): `groups(id TEXT PK, name, ...)` and `group_members(id TEXT PK, group_id → groups, player_id, role CHECK ('admin','member'), is_active SMALLINT)`.

### 1.2 Chat tables

Four tables. All ids are `TEXT`; message ids are **client-generated UUIDs** (`crypto.randomUUID()`), which is what makes optimistic sends de-dupe cleanly against the realtime echo.

#### `rooms`

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | TEXT | NO | — | PK. The seeded global room has id `'global'` |
| `kind` | TEXT | NO | — | `CHECK (kind IN ('global','group'))` |
| `group_id` | TEXT | YES | — | FK → `groups(id)`; NULL for the global room |
| `name` | TEXT | NO | — | display name |
| `created_at` | TIMESTAMPTZ | NO | `now()` | |

Seeded with a single row: `('global', 'global', NULL, 'Chat')`. **Only the global room is wired to UI**; group rooms exist in schema/policies only (deliberate Stage-1 scoping).

#### `messages`

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | TEXT | NO | — | PK, client-generated UUID |
| `room_id` | TEXT | NO | — | FK → `rooms(id)` |
| `author_player_id` | TEXT | NO | — | FK → `players(id)` |
| `body` | TEXT | YES | — | |
| `attachment_url` | TEXT | YES | — | full public storage URL, with `#w=<px>&h=<px>` fragment (§2.4) |
| `created_at` | TIMESTAMPTZ | NO | `now()` | server-assigned; ordering key |
| `deleted_at` | TIMESTAMPTZ | YES | — | soft delete (§1.4) |

Table constraint: `CHECK (body IS NOT NULL OR attachment_url IS NOT NULL)`.

Indexes:

```sql
CREATE INDEX messages_room_created_idx ON messages (room_id, created_at DESC); -- newest-first pagination
CREATE INDEX messages_deleted_at_idx   ON messages (deleted_at);
```

#### `room_reads` (read watermark for unread badges)

| column | type | null | default | notes |
|---|---|---|---|---|
| `player_id` | TEXT | (PK) | — | FK → `players(id)` |
| `room_id` | TEXT | (PK) | — | FK → `rooms(id)` |
| `last_read_at` | TIMESTAMPTZ | NO | `now()` | upserted on read |

Composite PK `(player_id, room_id)`. One watermark row per player per room; the client upserts it with PostgREST `Prefer: resolution=merge-duplicates`.

#### `message_reactions`

| column | type | null | default | notes |
|---|---|---|---|---|
| `message_id` | TEXT | (PK) | — | FK → `messages(id)` |
| `player_id` | TEXT | (PK) | — | FK → `players(id)` |
| `emoji` | TEXT | (PK) | — | `CHECK (char_length(emoji) <= 16)` |
| `created_at` | TIMESTAMPTZ | NO | `now()` | |

Composite PK `(message_id, player_id, emoji)` — one row per player per emoji per message. **Deliberate design:** the full row *is* the PK, so Supabase Realtime DELETE payloads (which carry only PK columns unless you set `REPLICA IDENTITY FULL`) contain everything the client needs to remove the reaction locally. No UPDATE path exists — reactions are added or removed, never edited.

### 1.3 Migration files (dependency order)

All in `windex-api/supabase/migrations/`:

| file | contents |
|---|---|
| `014_permissions.sql` | *(pre-existing)* the three SECURITY DEFINER helpers used by all chat RLS (§4.1) |
| `040_chat_schema.sql` | `rooms`, `messages`, `room_reads` + indexes + global-room seed + adds `messages` to the `supabase_realtime` publication |
| `041_chat_rls.sql` | RLS for all three tables + the immutability/soft-delete trigger |
| `042_message_reactions.sql` | `message_reactions` table + its RLS + adds it to the realtime publication |
| `043_soft_delete_one_way.sql` | replaces the trigger function body: non-admins cannot un-delete |
| `044_rounds_reads.sql` | *(not chat — a sibling feature that copies the `room_reads` watermark pattern for the Rounds tab; listed for completeness only)* |
| `045_chat_images_bucket.sql` | `chat-images` storage bucket + storage.objects policies |

### 1.4 Soft-delete vs hard-delete semantics

- **Hard delete is impossible for everyone** including super-admins via the API: there is *no* DELETE policy on `messages` (RLS default-deny).
- Delete = `PATCH ... { deleted_at: now() }`. The UPDATE policy lets authors (or super-admins) update their rows, and a `BEFORE UPDATE` trigger restricts the update to **only** the `deleted_at` column — every other column is immutable (raises on change).
- Migration 043 tightened the trigger: for non-super-admins `deleted_at` may only transition NULL → NOT NULL (no un-delete). Super-admins can reverse it (moderation un-delete).
- The client treats soft-deleted messages as gone: all reads filter `deleted_at=is.null`, and a realtime UPDATE carrying a non-null `deleted_at` removes the row from the visible list (and prunes its reactions from local state). Reaction rows for deleted messages are **not** deleted server-side — accepted retained data.
- Storage objects referenced by deleted messages are orphaned (no storage DELETE policy) — accepted debt, see §8.

---

## 2. Storage / Photo Upload

### 2.1 Bucket

One bucket, `chat-images`, created **in a migration, not the dashboard** (deliberate — see §8 "group-images lesson"):

```sql
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-images',
  'chat-images',
  true,                                          -- public read
  5242880,                                       -- 5 MiB
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;
```

Public read is deliberate: chat bubbles render via plain public URLs (no signed-URL machinery). PNG/WebP are allowed at the bucket for future/manual writes, but the client always uploads JPEG.

### 2.2 Bucket policies (on `storage.objects`)

```sql
CREATE POLICY "chat_images_select" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'chat-images');

CREATE POLICY "chat_images_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'chat-images'
    AND (storage.foldername(name))[1] IN (SELECT get_my_player_ids())
  );

-- No UPDATE or DELETE policies: objects are write-once in v1.
```

The INSERT policy requires the **first folder segment of the object path to be one of the caller's own player ids** — the same `get_my_player_ids()` helper the table RLS uses. This is the only enforcement of "you can only upload as yourself."

### 2.3 Path convention

```
chat-images/<author_player_id>/<uuid>.jpg
```

Generated client-side: `` `${authorId}/${crypto.randomUUID()}.jpg` ``.

### 2.4 Attachment ↔ message linkage

No attachments table. `messages.attachment_url` stores the **full public URL** with image dimensions appended as a URL fragment:

```
https://<project>.supabase.co/storage/v1/object/public/chat-images/<player_id>/<uuid>.jpg#w=1600&h=1200
```

The `#w=&h=` fragment is a deliberate hack: it lets the message list reserve the correct aspect-ratio box **before** the image loads (no layout jump), with zero extra columns and zero extra fetches. The fragment never reaches the server (fragments aren't sent in HTTP requests). The renderer parses it with `/#w=(\d+)&h=(\d+)/` and falls back to a 220×220 square if absent.

### 2.5 Client image pipeline (web-only, no native libraries)

**Not** expo-image-picker / expo-image-manipulator. The picker and processing are pure web APIs, gated `Platform.OS === 'web'` (Windex ships as a PWA; there is no native photo path — the 📷 button simply doesn't render on native):

1. **Pick:** imperatively create a hidden `<input type="file" accept="image/*">` DOM element and `.click()` it (react-native-web can't render a DOM input declaratively).
2. **Decode:** `createImageBitmap(file)`, falling back to `new Image()` + object URL for types `createImageBitmap` rejects. This also normalizes anything the browser can decode (HEIC on Safari, webp, png) to a canvas source.
3. **Downscale:** to a max long edge of **1600 px** (`scale = min(1, 1600/max(w,h))` — never upscales).
4. **Re-encode:** `canvas.toBlob(..., 'image/jpeg', 0.82)`.
5. **Size check:** reject if still > 5 MiB (`IMAGE_MAX_BYTES`, matching the bucket cap) with a user-facing error.
6. **Preview:** the blob goes into composer state as a `PendingImage { blob, width, height, previewUrl }` with an object-URL thumbnail and an ✕ cancel affordance.

Constants (in `chat.tsx`): `IMAGE_MAX_EDGE = 1600`, `IMAGE_JPEG_QUALITY = 0.82`, `IMAGE_MAX_BYTES = 5 * 1024 * 1024`.

### 2.6 Upload → send sequence (on Send)

1. Build optimistic message (client UUID, local object-URL as `attachment_url` with the same `#w=&h=` fragment) and prepend it to the list immediately; clear composer.
2. `POST {rest}/storage/v1/object/chat-images/<player_id>/<uuid>.jpg` with `Content-Type: image/jpeg`, body = blob, `Authorization: Bearer <user JWT>` + `apikey: <anon key>`.
3. On upload success, `POST {rest}/rest/v1/messages` with the **public** URL + dims fragment as `attachment_url` (and the same client-generated `id` as the optimistic row).
4. On any failure: remove the optimistic row, restore the composer text + pending image, show "Message failed to send."
5. If the upload succeeds but the message POST fails, the storage object orphans — accepted debt (same class as soft-delete orphans).

Size/type enforcement happens **twice**: client (re-encode + 5 MiB check) and bucket (`file_size_limit` + `allowed_mime_types`). There is no server-side dimension enforcement.

---

## 3. RLS Policies

All chat access is direct PostgREST with the user's JWT; RLS is the entire authorization layer. Helpers referenced below are in §4.1.

### 3.1 Plain-English permission model

- **Anyone authenticated** can see the room list and read messages/reactions in the global room (or in a group room if they're a member of that group).
- **You can post only as yourself** — `author_player_id` must be one of the player rows linked to your `auth.uid()` — and only into a room you can see.
- **Messages are immutable** except soft-delete. You can soft-delete your own messages; a super-admin can soft-delete anyone's and also un-delete. Nobody can hard-delete.
- **Reactions:** add as yourself on any visible message; remove only your own. No editing.
- **Read watermarks (`room_reads`):** you have full CRUD on your own rows only; nobody can read another player's watermark.
- **Rooms:** read-only to everyone; only super-admins can create/modify/delete rooms (in practice rooms are seeded by migration; no UI writes them).
- **Role gating:** the only roles are `players.is_super_admin` (smallint flag) and `group_members.role IN ('admin','member')`. Group admins have **no special chat powers** — only super-admin does (moderation delete/un-delete via direct API; there is no moderation UI).

### 3.2 Verbatim policies — migration `041_chat_rls.sql`

```sql
ALTER TABLE rooms      ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages   ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_reads ENABLE ROW LEVEL SECURITY;

-- rooms: anyone authenticated reads; only super-admin writes.
CREATE POLICY rooms_select ON rooms FOR SELECT TO authenticated USING (true);
CREATE POLICY rooms_insert ON rooms FOR INSERT TO authenticated WITH CHECK (am_i_super_admin());
CREATE POLICY rooms_update ON rooms FOR UPDATE TO authenticated
  USING (am_i_super_admin()) WITH CHECK (am_i_super_admin());
CREATE POLICY rooms_delete ON rooms FOR DELETE TO authenticated USING (am_i_super_admin());

-- messages: visible if the room is global or you're a member of its group.
CREATE POLICY messages_select ON messages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM rooms r
      WHERE r.id = messages.room_id
        AND (r.kind = 'global' OR am_i_group_member(r.group_id))
    )
  );

-- Insert only as one of your own players, into a room you can see.
CREATE POLICY messages_insert ON messages FOR INSERT TO authenticated
  WITH CHECK (
    author_player_id IN (SELECT get_my_player_ids())
    AND EXISTS (
      SELECT 1 FROM rooms r
      WHERE r.id = messages.room_id
        AND (r.kind = 'global' OR am_i_group_member(r.group_id))
    )
  );

-- Update your own messages (or super-admin). The trigger below restricts
-- which columns may actually change.
CREATE POLICY messages_update ON messages FOR UPDATE TO authenticated
  USING (
    am_i_super_admin()
    OR author_player_id IN (SELECT get_my_player_ids())
  );

-- No DELETE policy on messages: hard delete is forbidden (RLS default-deny).

-- room_reads: full access to your own watermark rows only.
CREATE POLICY room_reads_all ON room_reads FOR ALL TO authenticated
  USING (player_id IN (SELECT get_my_player_ids()))
  WITH CHECK (player_id IN (SELECT get_my_player_ids()));
```

### 3.3 Column-immutability / soft-delete trigger (041, body replaced by 043)

The UPDATE policy alone would let an author edit anything on their row. A `BEFORE UPDATE` trigger narrows it to `deleted_at` only, one-way for non-admins. Final version (043):

```sql
CREATE OR REPLACE FUNCTION messages_soft_delete_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id               IS DISTINCT FROM OLD.id
     OR NEW.room_id          IS DISTINCT FROM OLD.room_id
     OR NEW.author_player_id IS DISTINCT FROM OLD.author_player_id
     OR NEW.body             IS DISTINCT FROM OLD.body
     OR NEW.attachment_url   IS DISTINCT FROM OLD.attachment_url
     OR NEW.created_at       IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'messages are immutable except deleted_at (soft-delete only)';
  END IF;

  IF OLD.deleted_at IS NOT NULL
     AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     AND NOT am_i_super_admin()
  THEN
    RAISE EXCEPTION 'soft-delete cannot be reversed';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER messages_soft_delete_only_trg
  BEFORE UPDATE ON messages
  FOR EACH ROW
  EXECUTE FUNCTION messages_soft_delete_only();
```

### 3.4 Verbatim policies — `message_reactions` (042)

```sql
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;

-- Visible if the parent message's room is visible.
CREATE POLICY message_reactions_select ON message_reactions FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM messages m
      JOIN rooms r ON r.id = m.room_id
      WHERE m.id = message_reactions.message_id
        AND (r.kind = 'global' OR am_i_group_member(r.group_id))
    )
  );

-- React only as one of your own players, on a message you can see.
CREATE POLICY message_reactions_insert ON message_reactions FOR INSERT TO authenticated
  WITH CHECK (
    player_id IN (SELECT get_my_player_ids())
    AND EXISTS (
      SELECT 1 FROM messages m
      JOIN rooms r ON r.id = m.room_id
      WHERE m.id = message_reactions.message_id
        AND (r.kind = 'global' OR am_i_group_member(r.group_id))
    )
  );

-- Un-react: remove your own reactions only. (No UPDATE policy at all.)
CREATE POLICY message_reactions_delete ON message_reactions FOR DELETE TO authenticated
  USING (player_id IN (SELECT get_my_player_ids()));
```

Note the reaction SELECT/INSERT policies don't filter `m.deleted_at` — reacting to a soft-deleted message is technically permitted; the UI just never offers it.

---

## 4. RPCs / Server Functions

### 4.1 SECURITY DEFINER helpers (migration 014 — pre-date chat, reused by it)

These exist because RLS policies need to look across tables (`players`, `group_members`) that have their own RLS; SECURITY DEFINER lets the check bypass that without widening those tables' policies. All are `STABLE` SQL functions.

```sql
-- All player ids belonging to the calling auth user.
CREATE OR REPLACE FUNCTION get_my_player_ids()
RETURNS SETOF TEXT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id FROM players WHERE user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION am_i_super_admin()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM players WHERE user_id = auth.uid() AND is_super_admin = 1);
$$;

CREATE OR REPLACE FUNCTION am_i_group_member(gid TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM group_members gm
    WHERE gm.group_id = gid
      AND gm.player_id IN (SELECT id FROM players WHERE user_id = auth.uid())
  );
$$;
```

**Grants:** there are **no explicit `GRANT EXECUTE` statements** in any Windex migration. The functions rely on Postgres's default `EXECUTE` grant to `PUBLIC` on newly created functions. ⚠️ If your project revokes default function execute (some hardened setups do `REVOKE ALL ON FUNCTIONS FROM PUBLIC`), you'll need explicit `GRANT EXECUTE ... TO authenticated`. Also note these helpers don't set `search_path`; Honcut's existing `is_caretaker`-style helpers presumably follow your own conventions — keep those.

### 4.2 Chat-specific RPCs / Edge Functions

**None.** Sends, deletes, reactions, watermarks, and pagination are all direct PostgREST table operations under RLS. This was a deliberate decision: with client-generated message ids, an immutability trigger, and RLS that pins authorship to the caller, there was nothing left for an RPC to add. (Windex *does* use Edge Functions heavily elsewhere — standings, invites — just not for chat.)

The only other server-side function touching `players` is `link_player_on_auth_signup()` (migration 020, `AFTER INSERT ON auth.users`), which auto-links a pre-created player row to a new auth user by email match. Chat depends on this only indirectly (a user with no linked player row cannot chat — the client surfaces "No player profile found for your account.").

---

## 5. Realtime

### 5.1 Transport: `postgres_changes` (not broadcast, not polling)

Both `messages` and `message_reactions` are added to the `supabase_realtime` publication in their schema migrations (idempotent guard included):

```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public' AND tablename = 'messages'   -- and again for message_reactions
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE messages;
  END IF;
END $$;
```

`postgres_changes` (with RLS enforced via the user JWT on the socket) was chosen over broadcast so the database remains the single source of truth — no double-write of a broadcast payload, and deletes/reactions arrive as ordinary table events.

### 5.2 The dedicated session-less realtime client (`lib/supabase.ts`)

This is the most port-critical piece of plumbing. Windex runs **two** supabase-js clients:

- The **auth client** (inside `AuthContext.tsx`): `persistSession: true`, `autoRefreshToken: true`, owns the session.
- The **realtime client** (`lib/supabase.ts`): `persistSession: false, autoRefreshToken: false, detectSessionInUrl: false` — it does **zero** session management and just holds a websocket plus whatever JWT it's handed.

Why: two clients both persisting/refreshing the same stored session **race to rotate the single refresh token and can invalidate each other** — a known supabase-js multi-client footgun.

```ts
export const supabaseRealtime: SupabaseClient | null = hasSupabaseAuthConfig()
  ? createClient(getSupabaseUrl(), getSupabaseAnonKey(), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : null;

export function setRealtimeAuth(token: string | null): void {
  if (!supabaseRealtime) return;
  supabaseRealtime.realtime.setAuth(token ?? '');  // updates socket AND already-joined channels
}
```

**Token lifecycle:** `AuthContext`'s `onAuthStateChange` calls `setRealtimeAuth(session?.access_token ?? null)` on every event (`INITIAL_SESSION`, `SIGNED_IN`, `TOKEN_REFRESHED`, `SIGNED_OUT`), so a live subscription survives token rotation and never "goes deaf." Subscribing code *also* calls `setRealtimeAuth(await getStoredAccessToken())` immediately before `.subscribe()` (belt-and-suspenders).

### 5.3 Subscriptions

Two channels on the one shared socket, with **deliberately distinct topics** so they never collide in a duplicate join:

**Chat screen** — topic `messages:global`, exists only while the Chat tab is focused:

```ts
supabaseRealtime
  .channel(`messages:${ROOM_ID}`)
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages',
       filter: `room_id=eq.${ROOM_ID}` }, (p) => onInsert(p.new))
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages',
       filter: `room_id=eq.${ROOM_ID}` }, (p) => onUpdate(p.new))
  // Reactions: unfiltered (the table is chat-only; client matches by message id).
  // DELETE payloads carry PK columns only — which is the whole row by design.
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_reactions' },
       (p) => addReaction(p.new))
  .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'message_reactions' },
       (p) => removeReaction(p.old))
  .subscribe();
```

**Unread provider** (`ChatUnreadContext`) — topic `messages:global:unread`, app-lifetime, INSERT-only on `messages` with the same room filter; it only flips a boolean.

### 5.4 Lifecycle, reconnects, missed messages

- **Chat screen:** `useFocusEffect` → subscribe on tab focus, remove channel on blur/unmount. An `AppState` listener inside the same effect tears the channel down on background and, on return to `'active'`, **re-subscribes and gap-fills** by re-fetching the latest page and merging (`loadLatest('merge')`). Rationale: the OS suspends the websocket in a backgrounded PWA and **realtime delivery is not guaranteed across that gap** — re-subscribing alone would silently miss messages.
- **Unread provider:** same teardown/resubscribe-on-foreground pattern, plus a one-shot `checkUnread()` REST query on each foreground.
- **Merge function:** fetched rows merge into local state de-duped by id, kept sorted `created_at DESC` (`mergeDesc`). This single function handles initial load, gap-fill, optimistic-send echo, and failed-delete restore.
- Every INSERT seen while the screen is focused also advances the read watermark (the channel only exists while focused, so "received live" ⇒ "read").

### 5.5 Pagination

- `PAGE = 50`. Initial load: `GET /rest/v1/messages?room_id=eq.global&deleted_at=is.null&order=created_at.desc&limit=50`.
- Infinite scroll upward: when the inverted FlatList's `onEndReached` fires (threshold 0.3), fetch the next 50 with `&created_at=lt.<oldest-loaded created_at>` (keyset cursor, not offset). `hasMore` = "last page returned exactly 50 rows" — fewer than 50 stops further fetches.
- Author names are resolved lazily in batches (`getPlayerNames`, one `id=in.(...)` query per batch of unknown ids) and cached in a Map for the screen's lifetime. Reactions are batch-fetched per page of message ids (`message_id=in.(...)`).

---

## 6. Frontend Architecture

### 6.1 File inventory

All paths relative to the Expo app root (`windex-expo/`):

| file | role |
|---|---|
| `app/(tabs)/chat.tsx` | **The entire chat screen** (~1,150 lines): list, composer, image pipeline, realtime, optimistic sends, reactions, delete sheet, lightbox. Deliberately a single file — no sub-components. |
| `contexts/ChatUnreadContext.tsx` | App-lifetime unread-dot provider: own realtime channel + watermark check |
| `lib/chatAuthor.ts` | `getAuthorPlayerId()` — cached resolution of the user's deterministic author player id; `userIdFromJwt()` JWT-sub decoder |
| `lib/supabase.ts` | The session-less realtime client + `setRealtimeAuth()` |
| `contexts/AuthContext.tsx` | (pre-existing) calls `setRealtimeAuth` on every auth state change; exposes `getStoredAccessToken` via `lib/api.ts` |
| `lib/api.ts` | (pre-existing) `getStoredAccessToken()`, `getPlayerNames(ids) → Map<id, {display_name, full_name}>` |
| `lib/config.ts` | env plumbing: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, optional `EXPO_PUBLIC_LATE_ADD_API_URL` |
| `app/(tabs)/_layout.tsx` | Chat tab registration, unread dot badge, `useAppBadge` (PWA icon badge), `initialRouteName` pin |
| `lib/pwaUpdate.ts` | `setComposerBusy(bool)` — chat composer defers service-worker auto-reloads while focused/holding unsent text |
| `components/Drawer.tsx` | "Enable badge notifications" affordance (iOS needs notification permission for the icon badge) |

### 6.2 State management

- **All message/reaction/composer state is local `useState` in `chat.tsx`.** No store, no react-query. Context is used only for the cross-tab unread flag (`ChatUnreadContext`).
- `messages: Message[]` held **newest-first** (`created_at DESC`).
- `reactions: Map<message_id, Reaction[]>` — raw rows, aggregated into per-emoji pills (`{emoji, count, mine}`) at render time.
- `names: Map<player_id, {display_name, full_name}>` — lazily filled author-name cache.
- Refs for things that must not retrigger renders/effects: the channel handle, `loadingOlderRef`, `hasMoreRef`, `chatFocusedRef` (in the provider).

### 6.3 Author identity

`getAuthorPlayerId()` (in `lib/chatAuthor.ts`): decodes `sub` from the stored JWT, then fetches `players?user_id=eq.<sub>&order=created_at.asc&limit=1` — the **earliest-created** player row, making the author deterministic when one user owns several player rows. Result is cached per auth user (keyed by JWT `sub`, so switching accounts refetches). Used by: send (authorship), bubble alignment (mine/theirs), unread provider (ignore own messages), watermark upserts. *Honcut's 1:1 `user_profiles`↔`auth.uid` makes this trivially simpler.*

### 6.4 Message list rendering

- `FlatList` with `inverted` — data is DESC so index 0 renders at the bottom (newest). `keyExtractor={(m) => m.id}`.
- `onEndReached={loadOlder}` + `onEndReachedThreshold={0.3}` for upward infinite scroll; `ListFooterComponent` spinner while loading older (renders at the visual top).
- iMessage-style grouping: since the list is DESC, `messages[index + 1]` is the chronologically **previous** message (rendered visually above). The author label shows only on non-own messages when the author changed; vertical gap is 10px on author change vs 4px within a run.
- Own messages right-aligned in an olive bubble (`#4B5E2A`), others left-aligned grey/card. Bubble text 19pt (platform-chat-convention sizing).
- Image bubbles: dims from the URL fragment, scaled to fit 240w × 320h (square 220 fallback); optional caption below; tap opens a full-screen lightbox `Modal` (tap anywhere dismisses).
- Empty/center states need `transform: [{ scaleY: -1 }]` to counteract the inverted list.
- Timestamps: time-only for today, `MMM d h:mm` otherwise, under each bubble.

### 6.5 Composer / optimistic send / retry

- Multiline `TextInput` (maxHeight 120) wrapped in a `flex: 1, minWidth: 0` View — required on web because a bare `<textarea>`'s intrinsic min-width refuses to shrink and pushes the Send button off-screen.
- **Font size ≥16px on the input is mandatory** (currently 19): iOS Safari auto-zooms on focusing any input under 16px, which wrecked the layout. This zoom — not offset math — was the original "composer shoved off-screen" bug.
- Send is disabled while sending or when there's neither trimmed text nor a pending image.
- **Optimistic send:** build the row with a client `crypto.randomUUID()` id, prepend, clear composer → (upload image if any) → `POST /rest/v1/messages` with that same id. The realtime echo de-dupes by id. On failure: remove optimistic row, restore composer text + image, show error. **No automatic retry; no queued outbox** — retry is the user pressing Send again.
- **Optimistic reactions and delete** follow the same pattern with revert-on-failure (delete restores the row via `mergeDesc`, which reinserts at the correct DESC position).
- Long-press on a bubble opens a **custom Modal action sheet** (RN `Alert`/`ActionSheetIOS` are no-ops on react-native-web): a row of 5 reaction emojis (`👍 😂 🔥 ⛳ 💀`), "Delete message" (own messages only), Cancel. Delete and reaction-removal get an in-sheet confirm step. Tapping a pill you've already reacted with opens the sheet directly in remove-confirm mode (adding is one tap; removing is deliberate).
- Composer reports busy state (`setComposerBusy`) so a pending service-worker auto-update never reloads the page mid-composition.

### 6.6 Unread counts / badges

Three layers, all boolean ("has unread"), not counts:

1. **Watermark:** the chat screen upserts `room_reads (player_id, room_id, last_read_at=now())` on focus and on every live insert received while focused. PostgREST upsert: `POST /rest/v1/room_reads` with `Prefer: resolution=merge-duplicates,return=minimal`.
2. **Tab dot:** `ChatUnreadProvider` (mounted in the tab layout, wrapping the navigator) holds `hasUnread`. Computation (one round-trip pair): latest non-self, non-deleted message's `created_at` vs own `last_read_at`; missing watermark row counts as unread iff any qualifying message exists. Set live via its own INSERT subscription (ignoring own messages and ignoring everything while the chat screen reports itself focused, via `setChatFocused`). Rendered as `tabBarBadge: hasUnread ? '' : undefined` with a 10px dot-sized `tabBarBadgeStyle`.
3. **PWA icon badge:** `useAppBadge` in the tab layout calls `navigator.setAppBadge(n)` / `clearAppBadge()` where n = number of unread features (chat + rounds). Always pass a **count** — the iOS no-arg "dot" form *clears* instead of rendering (WebKit bug 254884).

### 6.7 Navigation integration

Chat is a **tab** (`app/(tabs)/chat.tsx`), registered in `app/(tabs)/_layout.tsx` with a `message.fill` icon. Gotcha: adding the chat route perturbed expo-router's implicit initial-route resolution and users started landing on Chat after login; fixed by pinning `export const unstable_settings = { initialRouteName: 'standings' }` in the tab layout. If chat is your alphabetically-early route, expect the same.

---

## 7. Notifications

- **No push notifications.** No Expo push, no FCM/APNs, no Edge Function triggers, no `push` handler in the service worker. ("Tier 2" — `pushManager.subscribe()` — is a marked TODO in `Drawer.tsx`, to be chained off the same user gesture as the permission grant, but is not built.)
- In-app: the tab dot and the PWA **icon badge** (§6.6) are the entire notification surface. Both are driven by foreground realtime + on-foreground re-checks — nothing arrives while the app is fully closed.
- iOS-specific: the icon badge renders only after **notification permission** is granted, so the drawer shows an "Enable badge notifications" item when running standalone with the Badging API present and permission still `'default'`. `Notification.requestPermission()` **must be called directly inside the user gesture** (iOS rule). iOS is also known to misreport `Notification.permission`, so the handler stays idempotent (re-tap just requests again). A `windex-badge-permission-granted` window event tells `useAppBadge` to re-apply the current count after a grant.

---

## 8. Known Issues, Gotchas, and Decisions

Hard-won items, roughly in the order they bit:

**iOS PWA / web platform**
1. **Standalone-PWA keyboard overlay.** A Safari *tab* resizes the viewport when the keyboard opens, so things "just work." An installed (standalone) PWA **overlays** the keyboard without resizing the layout viewport, and react-native-web's `KeyboardAvoidingView` never reacts — the composer ends up hidden and the layout goes stale until a touch forces a repaint. Fix: a `useStandaloneKeyboardInset()` hook that reads `window.visualViewport` (`innerHeight - vv.height - vv.offsetTop`) and pads the content; scoped to standalone web only. Took an on-screen visualViewport debug overlay (a temporary instrumentation commit) to diagnose.
2. **`KeyboardAvoidingView` is disabled on web entirely** (`enabled={Platform.OS !== 'web'}`): its bottom padding fails to reset after send in a standalone PWA (keyboard-dismiss event unreliable), leaving stale layout.
3. **Input font-size must be ≥16px** or iOS auto-zooms on focus and shoves the composer off-screen. The zoom was the bug; offset math was a red herring.
4. **Web `<textarea>` min-width**: wrap the TextInput in a `flex:1, minWidth:0` View or the Send button clips off-screen.
5. **`Alert.alert` / `ActionSheetIOS` are silent no-ops on react-native-web** — every confirm/sheet must be a hand-rolled `Modal`.
6. **`navigator.setAppBadge()` with no argument clears on iOS** instead of showing a dot (WebKit bug 254884) — always pass a count.
7. **The file picker must be an imperative DOM `<input type="file">`** — react-native-web has no picker, and expo-image-picker wasn't used (PWA-only distribution).

**Supabase / realtime**
8. **Two persisting supabase-js clients race on the refresh token** and can sign each other out. The realtime client must be session-less (`persistSession: false, autoRefreshToken: false`) and be fed tokens from the one auth client.
9. **Channels go deaf after token refresh** unless something calls `realtime.setAuth(newToken)` — wire it into `onAuthStateChange` for *every* event, and again right before each `.subscribe()`.
10. **Realtime is not guaranteed across app backgrounding** (the OS suspends the socket). Don't trust resubscribe alone: on foreground, also re-fetch the latest page and **merge** (de-dupe by id, re-sort) to fill the gap.
11. **Realtime DELETE payloads carry only PK columns** (without `REPLICA IDENTITY FULL`). Designing `message_reactions` so the whole row *is* the PK made DELETE events self-sufficient — do this rather than flipping replica identity.
12. **Two subscriptions to the same topic collide** (duplicate-join). The screen channel and the unread channel use distinct topics (`messages:global` vs `messages:global:unread`).
13. **RLS UPDATE policies don't restrict columns** — pair them with a BEFORE UPDATE trigger for immutability. And test un-delete: v1 of the trigger accidentally allowed authors to reverse their own soft-deletes (fixed in 043).

**Storage**
14. **Create buckets in migrations, never the dashboard.** An earlier bucket (`group-images`) was dashboard-created with wide-open authenticated INSERT and had to be retro-tightened in a later migration (026). `chat-images` was migration-managed from birth as the explicit lesson learned.
15. **Orphaned objects are accepted debt**: no storage DELETE policy, so deleting a message (or a message-POST failing after upload) strands its image. Acceptable at club scale; revisit if storage costs matter.

**Product/architecture decisions**
16. **`postgres_changes` over broadcast**: DB stays the single source of truth; deletes and reactions arrive as table events; no double-write. Cost: each subscriber's RLS is evaluated per event — fine at this scale (~dozens of users).
17. **Single global room shipped first** with the multi-room schema (rooms.kind='group', membership-aware policies) dormant. The UI hardcodes `ROOM_ID='global'`; going multi-room is a UI problem, not a schema problem.
18. **No RPC layer** — client-generated UUIDs + RLS authorship pinning + the immutability trigger made direct table writes safe. If you need an audit log on sends (Honcut pattern), that's the one reason to wrap the INSERT in a SECURITY DEFINER RPC instead.
19. **Soft-delete vanishes the message entirely** (no "message deleted" tombstone in the list) — deliberate product choice.
20. **Adding a tab can change your app's landing route** under expo-router — pin `initialRouteName`.
21. **Service-worker auto-update vs the composer**: an auto-reload can eat a half-typed message; the composer reports busy state and the updater defers reloads until idle.
22. **Reaction emoji set is a fixed array of 5** (`['👍','😂','🔥','⛳','💀']`) — no emoji keyboard; keeps the sheet and the pill aggregation trivial. Swap `⛳` for something duck-shaped.

**If rebuilding** (observations, not blockers): the name-resolution cache (`names` in the `resolveNames` dependency array) recreates the callback on every fetch — harmless but a `useRef` cache would be cleaner; the unread provider and chat screen share a lot of boilerplate that could be one hook; and a tiny outbox/retry queue would beat restore-the-composer for flaky-network sends.

---

## 9. Dependency List

Chat-relevant packages beyond the base Expo template (from `windex-expo/package.json`):

| package | version | chat usage |
|---|---|---|
| `@supabase/supabase-js` | `^2.99.2` | realtime client only (auth client lives elsewhere) |
| `@supabase/auth-js` | `2.99.2` (pinned) | session handling for the auth client |
| `expo-image` | `~3.0.11` | attachment bubbles, pending-image thumbnail, lightbox (`ExpoImage`, `contentFit`) |
| `@react-navigation/bottom-tabs` | `^7.4.0` | tab + `tabBarBadge` dot |
| `@react-navigation/native` | `^7.1.8` | `useFocusEffect` (channel lifecycle) |
| `react-native-safe-area-context` | `~5.6.0` | composer insets |
| `expo-router` | `~6.0.23` | tab registration, `initialRouteName` pin |

**Notably absent:** `expo-image-picker`, `expo-image-manipulator`, `react-native-gifted-chat`, any state-management or data-fetching library. Image pick/resize is pure web API (DOM file input + canvas); everything else is `fetch` + `useState`.

### 9.1 Environment variables and secrets — complete inventory

Everything chat touches, from `lib/config.ts` (the only env access path):

| variable | where set | required | chat usage |
|---|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | Vercel build env / local `.env` | yes | realtime websocket; REST base (`{url}/rest/v1`, `{url}/storage/v1`) is derived from it |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Vercel build env / local `.env` | yes | `apikey` header on every PostgREST/storage call; realtime client key |
| `EXPO_PUBLIC_LATE_ADD_API_URL` | Vercel build env / local `.env` | no | optional explicit Edge Functions base; chat only uses it to *derive* the REST root by stripping `/functions/v1`. If unset, falls back to `EXPO_PUBLIC_SUPABASE_URL` |

That's the whole list. **Chat uses no server-side secrets**: no Edge Functions → no function env vars; no push → no Expo push tokens, VAPID keys, or APNs/FCM credentials; no service-role key anywhere in the client. All three variables are public (baked into the static PWA bundle at build time — `EXPO_PUBLIC_` prefix), so mirroring to Honcut's Vercel project is just the two Supabase values.

---

## 10. Dashboard-Only Configuration Audit

The classic silent-failure risk in a Supabase port is config that lives only in the dashboard. Audit result for chat:

**Version-controlled in SQL (nothing to recreate by hand):**
- ✅ `chat-images` bucket creation **and** its config (public flag, 5 MiB limit, MIME allowlist) — migration 045 inserts directly into `storage.buckets`.
- ✅ All `storage.objects` policies for chat — migration 045.
- ✅ Realtime enablement — migrations 040/042 add `messages` and `message_reactions` to the `supabase_realtime` publication in SQL (the dashboard "Realtime" toggle is just UI over this same publication). The idempotent `DO $$ ... ALTER PUBLICATION` blocks are in §5.1.
- ✅ All table RLS, triggers, helper functions — migrations 014/041/042/043.

**Dashboard-only / implicit dependencies to verify on the target project:**
1. **The `supabase_realtime` publication must exist.** It does by default on every Supabase project, but if Honcut's was ever dropped/recreated, `ALTER PUBLICATION supabase_realtime ADD TABLE ...` fails. Check: `SELECT * FROM pg_publication WHERE pubname = 'supabase_realtime';`
2. **Realtime postgres_changes must be enabled at the project level** (Settings → API → Realtime; on by default). Symptom if off: subscriptions join fine but no events arrive — exactly the "compiles fine, silently fails" failure mode.
3. **Running migration 045 by hand requires sufficient privileges on `storage.objects`** — execute it in the dashboard SQL editor (runs as `postgres`) or via `supabase db push`. A restricted role can't create policies on the `storage` schema.
4. **Default function EXECUTE grants** (§4.1): Windex relies on Postgres's default grant-to-PUBLIC for the helper functions. If Honcut hardens default privileges, add explicit `GRANT EXECUTE ... TO authenticated`.
5. **Historical caveat:** the *non-chat* `group-images` bucket was dashboard-created and only retro-fixed in migration 026 — that's the incident that drove the everything-in-SQL rule for chat. Nothing chat-related has this problem, but it's why you should not assume the same of other Windex features.
6. ⚠️ **Drift check worth running once:** this document is derived from migration files, not a live `pg_dump`. Before porting, run `supabase db dump --schema public --linked` (or inspect via dashboard) on Windex and diff the four chat tables + policies against §1/§3 to confirm no hotfix was ever applied dashboard-side. No such hotfix is known, but the check costs one command.

---

## 11. Post-Port Smoke-Test Checklist

Manual verification sequence, ordered so each step's prerequisites are proven by the previous ones. "Device B" = a second browser/profile signed in as a different member.

1. **Schema sanity:** in SQL editor — `SELECT * FROM rooms;` returns the seeded global room; `SELECT relrowsecurity FROM pg_class WHERE relname IN ('rooms','messages','room_reads','message_reactions');` all `true`; `SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime';` includes `messages` and `message_reactions`.
2. **Plain send:** Device A sends a text message → appears instantly (optimistic) and survives a page reload (server row persisted).
3. **Realtime delivery:** with Device B already on the chat screen, Device A sends → B receives within ~1s without refreshing. Then background B (switch apps / tab), send two more from A, foreground B → both appear (gap-fill merge works).
4. **Photo flow:** Device A attaches a large photo (>5 MB original) → preview thumbnail shows; send → bubble renders at correct aspect ratio; verify in Storage that the object landed at `chat-images/<profile_id>/<uuid>.jpg` and is < 5 MiB; tap bubble → lightbox opens.
5. **Reactions:** B long-presses A's message, adds 👍 → pill appears on both devices live; B taps the pill again → remove-confirm → pill count drops on both. A reacting with the same emoji increments the count to 2.
6. **Soft delete:** A long-presses own message → Delete → vanishes on both devices live. SQL check: row still exists with `deleted_at` set. Attempt `UPDATE messages SET deleted_at = NULL WHERE id = '<that id>'` as a non-admin user (via REST with their JWT) → rejected ("soft-delete cannot be reversed").
7. **RLS denial — authorship spoof:** as user B, POST a message with `author_player_id` (Honcut: profile id) belonging to A → must fail with a 403/RLS violation. Same test against `message_reactions` and a storage upload to `chat-images/<A's id>/x.jpg`.
8. **RLS denial — excluded role:** sign in as a `custom_farmer` → the message INSERT must fail at the API even if the UI is bypassed (curl with their JWT). Confirm reads still work for that role if that's the intent.
9. **Edit immutability:** as the author, PATCH `body` on an own message → rejected by the trigger ("messages are immutable except deleted_at").
10. **Unread + watermark:** Device B navigates away from chat; A sends → B's chat tab dot appears (and PWA icon badge if installed/permission granted); B opens chat → dot clears; SQL check: B's `room_reads.last_read_at` advanced. Confirm A's own sends never set A's dot.
11. **Token-rotation longevity (optional but recommended):** leave a device on the chat screen past one JWT lifetime (default 1 h) → a message sent after rotation still arrives live (the `setAuth`-on-refresh wiring works).

---

## Appendix: Honcut adaptation crib notes

No action required — just the obvious mappings so nothing in this doc misleads:

- `players` → `user_profiles`; `get_my_player_ids()` → since Honcut is 1:1 profile↔auth user, policies can simply compare a `user_id` column to `auth.uid()` (or keep a helper for symmetry with `is_caretaker`). The whole "deterministic earliest player row" machinery (`lib/chatAuthor.ts`) collapses to a trivial profile lookup.
- **Poster gating ("everyone except `custom_farmer`") — exact injection map.** Windex has **no posting-restricted role anywhere in chat**, so this is new policy text, not a port. The complete, exhaustive list of places where chat checks caller identity — i.e., every candidate injection point for `AND NOT is_custom_farmer(auth.uid())`:

  | location | current identity check | inject the farmer exclusion? |
  |---|---|---|
  | `messages_insert` WITH CHECK (§3.2) | `author_player_id IN (SELECT get_my_player_ids())` | **Yes — this is the one mandatory change.** |
  | `message_reactions_insert` WITH CHECK (§3.4) | `player_id IN (SELECT get_my_player_ids())` | Yes, if farmers shouldn't react either |
  | storage `chat_images_insert` WITH CHECK (§2.2) | path's first folder ∈ `get_my_player_ids()` | Yes, if farmers shouldn't upload (defense in depth even though they can't post the message row) |
  | `messages_update` USING (§3.2) | super-admin OR own `author_player_id` | No — farmers can't have authored anything to delete |
  | `messages_select` / `message_reactions_select` | room visibility only (no identity beyond `authenticated`) | No — unless farmers also shouldn't *read*, in which case gate here too |
  | `room_reads_all` (§3.2) | own `player_id` rows only | No — watermarks are harmless |
  | client `getAuthorPlayerId()` / send button | resolves own profile id | Optional UI mirror: hide the composer for farmers so the RLS denial is never user-visible |

  No RPC or Edge Function checks identity for chat (there are none, §4.2) — the table above is the complete authorization surface.
- Windex's `am_i_super_admin()` maps to whatever Honcut's admin/caretaker-equivalent moderation role should be.
- If announcements should be one-to-many rather than open chat, the cheapest lever is the same `messages_insert` policy — restrict who may INSERT, leave reads/reactions as-is.
- Honcut's audit-log-via-RPC pattern: see §8 item 18 — wrap the message INSERT in a SECURITY DEFINER RPC if sends must be audited; nothing else in the design resists that change.
- Migration order for hand-running: helpers (your equivalents likely exist) → 040-equivalent (schema + realtime publication) → 041-equivalent (RLS + trigger, with the **043 trigger body**, skipping the two-step history) → 042-equivalent (reactions) → 045-equivalent (bucket).
