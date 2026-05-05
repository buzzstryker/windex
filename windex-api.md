# windex-api — Structure

Backend/API for Windex. Lives in **`windex-api/`** in this directory. Product overview: [README.md](./README.md). Setup and run: [windex-api/README.md](./windex-api/README.md).

**Structure:**

```
windex-api/
├── docs/                    # API contract, payout/settlement design
├── supabase/
│   ├── migrations/          # Schema and RLS
│   └── functions/           # Edge Functions (ingest, standings, compute-money-deltas, generate-payment-requests)
├── tests/
├── README.md
├── CLAUDE.md
└── package.json
```

- **docs/** — Full API spec, validation, error codes; payout and settlement design.
- **supabase/migrations/** — Timestamped SQL; tables, indexes, RLS.
- **supabase/functions/** — One folder per Edge Function.
- **README.md** — Setup, run, deploy, testing (in that folder).
- **CLAUDE.md** — Project rules for AI/editor. Template at root: [windex-api-CLAUDE.md](./windex-api-CLAUDE.md).
