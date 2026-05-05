# shared-golf-types

Shared TypeScript types used by windex-api and by other apps (e.g. Windex UI, or other golf apps that integrate with the API). Suggested repo structure:

```
shared-golf-types/
├── src/
│   ├── late-add/
│   └── scorekeeper/
├── package.json
└── README.md
```

- **src/late-add/** — Types for Late Add Golf (API and app).
- **src/scorekeeper/** — Types for Scorekeeper or other golf apps (players, rounds, courses, betting, etc.) if shared.
- **package.json** — Package name, exports, and build (e.g. tsc or unbuild).
- **README.md** — Install, import, and versioning.

Publish as a private or public npm package (or use a workspace/monorepo reference) so both repos depend on it.
