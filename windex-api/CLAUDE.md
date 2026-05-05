# windex-api

Backend/API for Late Add Golf: groups, seasons, league rounds, scores, standings. Supabase (Postgres, Auth, Edge Functions). Consumed by scorekeeper-app; types shared with shared-golf-types where possible.

## Repo structure

```
windex-api/
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
- **supabase/migrations/** — SQL migrations; one logical change per file.
- **supabase/functions/** — Edge Functions; thin handler, logic in src/services.
- **src/services/** — Business logic; call Supabase.
- **src/lib/** — Supabase client, env, helpers.
- **src/types/** — Request/response and DB types until moved to shared-golf-types.

## Rules

- Edge Functions stay thin: parse request, call service, return response.
- Business logic and validation live in **src/services/**.
- No domain logic in function bodies or in migrations beyond DDL.
- Prefer shared-golf-types for types used by app and API.
- Migrations: clear names; RLS in dedicated migration or with schema.

## References

- Schema and API: **docs/** in this folder; product docs and data model in the parent Windex directory (../*.md).
