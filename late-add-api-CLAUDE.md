# late-add-api — CLAUDE.md

Use as **late-add-api/CLAUDE.md** (template; the project already has [late-add-api/CLAUDE.md](./late-add-api/CLAUDE.md) in this directory).

---

## Project

late-add-api is the backend/API for Windex (a standalone app, separate from Scorekeeper). Groups, seasons, league rounds, and scores. Supabase (Postgres, Auth, Edge Functions). Consumed by the Windex app and by any other source apps that call the API; types shared with shared-golf-types where possible.

## Repo structure

```
late-add-api/
├── docs/
├── supabase/
│   ├── migrations/
│   └── functions/
├── src/
│   ├── services/
│   ├── lib/
│   └── types/
├── README.md
└── CLAUDE.md
```

- **docs/** — API spec, runbooks.
- **supabase/migrations/** — Timestamped SQL; one logical change per file.
- **supabase/functions/** — One folder per Edge Function; thin handler, logic in src/services.
- **src/services/** — Business logic; call Supabase (and shared-golf-types when used).
- **src/lib/** — Supabase client, env, helpers.
- **src/types/** — Request/response and DB types until moved to shared-golf-types.

## Rules

- Edge Functions stay thin: parse request, call service, return response.
- Business logic and validation live in **src/services/**.
- Do not put domain logic in function bodies or in migrations beyond DDL.
- Prefer shared-golf-types for types used by the app and API; keep src/types/ for API-only or temporary types.
- Migrations: timestamped names (YYYYMMDDHHMMSS_description.sql); RLS in a dedicated migration after tables.

## References

- API and schema: see **late-add-api/docs/** in this directory and the root-level bootstrap, data model, and API spec.
