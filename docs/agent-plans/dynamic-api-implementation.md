# Dynamic API — Implementation Plan

## Overview

A Cloudflare Workers service where you describe an application in text and get a live API endpoint powered by LLM-generated code. Each "app" has a stable URL, versioned code history, and is executed via Cloudflare Dynamic Workers on every inbound request.

## Architecture Summary

- **Management plane**: Hono routes under `/api/apps/*` for CRUD on app definitions
- **Execution plane**: Hono route `/apps/:idOrSlug/*` that loads generated code and runs it via Dynamic Workers
- **Storage**: AppDO (SQLite, per app) as source of truth → Workers KV (current version cache) → in-memory Map (per-isolate hot cache)
- **Code generation**: Cloudflare AI Gateway → Anthropic Claude Sonnet 4.6
- **Runtime**: Dynamic Workers loader (`env.LOADER.get(key, codeCallback)`) executes generated `WorkerEntrypoint` code

---

## Milestone 1 — Project Infrastructure

**Goal**: Get the wrangler config, TypeScript types, and DO/KV bindings wired up so the project builds cleanly with all new bindings declared.

### Tasks

1. **Install new dependencies**
   - `durable-utils` — SQLite schema migration helper for Durable Objects
   - `valibot` — schema validation for API request bodies

2. **Convert `wrangler.toml` → `wrangler.jsonc`**
   - Rename file and reformat as JSONC
   - Add DO bindings: `APP_DO` (class `AppDO`), `REGISTRY_DO` (class `RegistryDO`)
   - Add SQLite migration: `{ "tag": "v1", "new_sqlite_classes": ["AppDO", "RegistryDO"] }`
   - Add KV namespace binding: `APP_KV` (stub ID for local dev; real ID after `wrangler kv namespace create`)
   - Add Dynamic Workers loader binding (exact key TBD — verify from CF beta docs/wrangler source)
   - Add `vars` stubs for `CF_ACCOUNT_ID`, `AI_GATEWAY_ID` (actual values go in `.dev.vars` / wrangler secrets)

3. **Regenerate worker types**
   - Run `wrangler types` to regenerate `worker-configuration.d.ts`
   - Confirm `Env` interface reflects `APP_DO`, `REGISTRY_DO`, `APP_KV`, `LOADER`

4. **Stub out DO class files**
   - `src/do/AppDO.ts` — empty class extending `DurableObject`, exported
   - `src/do/RegistryDO.ts` — empty class extending `DurableObject`, exported
   - Export both from `src/index.ts` (required for DO resolution)

5. **Verify build passes** (`npm run dev` or `wrangler dev --dry-run`)

---

## Milestone 2 — AppDO (SQLite Schema + Version History)

**Goal**: A fully functional Durable Object per app that stores all version history in SQLite and exposes methods for the management API to call.

### SQLite Schema (inside AppDO)

```sql
CREATE TABLE IF NOT EXISTS app_meta (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_versions (
  version    INTEGER NOT NULL PRIMARY KEY,
  prompt     TEXT NOT NULL,
  code       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Schema is managed via `durable-utils` migrations. Each DO holds a `SQLSchemaMigrations` instance and calls `runAll()` before any operation:

```ts
import { SQLSchemaMigrations, type SQLSchemaMigration } from "durable-utils/sql-migrations";

const MIGRATIONS: SQLSchemaMigration[] = [
  {
    idMonotonicInc: 1,
    description: "initial schema",
    sql: `
      CREATE TABLE IF NOT EXISTS app_meta (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_versions (
        version INTEGER NOT NULL PRIMARY KEY,
        prompt TEXT NOT NULL, code TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `,
  },
];

export class AppDO extends DurableObject {
  #migrations: SQLSchemaMigrations;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#migrations = new SQLSchemaMigrations({ doStorage: ctx.storage, migrations: MIGRATIONS });
  }

  async #ensureSchema() {
    await this.#migrations.runAll();
  }
  // ...
}
```

Future schema changes add a new `{ idMonotonicInc: 2, ... }` entry; already-run migrations are skipped automatically.

### `appCtx` Storage Key

Before any SQL work, the DO stores its own identity in the DO's KV storage under the key `"appCtx"`:

```ts
type AppCtx = { appId: string; workspace: string };
// stored via: await this.ctx.storage.put("appCtx", { appId, workspace })
// read via:   await this.ctx.storage.get<AppCtx>("appCtx")
```

This gives the DO self-knowledge that it otherwise lacks — the CF runtime does not expose the string passed to `idFromName`. Other methods (e.g. pushing stats to RegistryDO) retrieve `appCtx` from storage rather than accepting it as a parameter on every call.

### DO Methods (called via DO stub RPC)

| Method | Input | Output | Notes |
|---|---|---|---|
| `init(appId, workspace)` | `string, string` | `void` | Called first on creation; idempotent — writes `appCtx` to KV storage only if not already set |
| `createVersion(id, slug, description, code, prompt)` | — | `AppRecord` | Called after `init`; runs migrations, inserts meta if first call, always inserts new version row; returns current record |
| `getCurrent()` | — | `AppRecord` | Reads meta + latest version |
| `getHistory()` | — | `AppVersion[]` | All rows from `app_versions` |
| `getVersion(n)` | version number | `AppVersion \| null` | Single version lookup |

### Shared Types (`src/types.ts`)

```ts
type AppVersion = {
  version: number;
  prompt: string;
  code: string;
  created_at: string; // ISO 8601
};

type AppRecord = {
  id: string;
  slug: string;
  description: string;
  created_at: string; // app creation time (from app_meta)
  current: AppVersion;
};
```

### After each `createVersion`

On initial creation (`POST /api/apps`), the RegistryDO row is written synchronously with retries before `createVersion` is called (see Milestone 5). After `createVersion` returns, a `ctx.waitUntil` async call bumps `total_versions` and `last_updated` in the RegistryDO row.

On subsequent updates (`PUT /api/apps/:id`), the only RegistryDO write is the async `ctx.waitUntil` stat bump — the row already exists.

---

## Milestone 3 — RegistryDO (SQLite Bookkeeping)

**Goal**: A singleton DO that holds a summary of all apps for the listing endpoint. Never in the hot execution path.

### SQLite Schema (inside RegistryDO)

```sql
CREATE TABLE IF NOT EXISTS apps (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL,
  description    TEXT NOT NULL,
  total_versions INTEGER NOT NULL DEFAULT 1,
  last_updated   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
```

Schema managed via `durable-utils` migrations, same pattern as AppDO. The single migration entry creates the `apps` table; future columns are added as new migration entries.

### DO Methods

| Method | Notes |
|---|---|
| `upsertApp(record)` | INSERT OR REPLACE; called synchronously with retries on app creation, async (`ctx.waitUntil`) on subsequent updates |
| `listApps()` | SELECT * FROM apps ORDER BY created_at DESC |

### Singleton Access Pattern

```ts
const registryId = env.REGISTRY_DO.idFromName("default");
const registry = env.REGISTRY_DO.get(registryId);
```

The name `"default"` is the implicit namespace. Future workspaces become `idFromName(workspaceId)`.

---

## Milestone 4 — Workers KV + In-Memory Cache Layer

**Goal**: A `getAppRecord(appId, env)` utility that abstracts the three storage layers and is used by both the management API and execution plane.

> Slug-based KV routing is deferred. The execution plane URL uses the app ID directly. A `slug:{slug}` → `id` KV entry will be added in a follow-up milestone.

### KV Key Layout

| Key | Value | Written by |
|---|---|---|
| `app:{id}` | Full `AppRecord` JSON (including current code) | Management API after every version change |

A single KV read on the hot path is sufficient — no secondary slug key for now.

### In-Memory Cache

Module-level `Map` in the execution layer (lives for the lifetime of the isolate):

```ts
const appCache = new Map<string, { record: AppRecord; cachedAt: number }>();
const CACHE_TTL_MS = 60_000;
```

### `getAppRecord` Utility (`src/lib/appCache.ts`)

```
1. Check appCache for appId — return if present and age < TTL
2. KV GET "app:{appId}" — cache and return if found
3. Fall back to AppDO.getCurrent() (handles the window between app creation
   and KV write, or KV unavailability)
4. Return null if not found in any layer
```

### `writeAppRecord` Utility

Called by management API after AppDO writes a new version:
- KV PUT `app:{id}` with the full `AppRecord`
- Evict `appCache` entry for `id`

---

## Milestone 5 — Management API (Hono Routes)

**Goal**: Full CRUD for app definitions, wired to AppDO and RegistryDO, with valibot-validated request bodies.

### Routes

```
POST   /api/apps              Create app (codegen happens here)
GET    /api/apps              List all apps (from RegistryDO)
GET    /api/apps/:id          Get current AppRecord
PUT    /api/apps/:id          Update description → regenerate code
GET    /api/apps/:id/history  All AppVersion[]
GET    /api/apps/:id/history/:version  Single AppVersion
```

### Valibot Schemas (`src/lib/schemas.ts`)

```ts
import * as v from "valibot";

export const CreateAppSchema = v.object({
  slug: v.optional(
    v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,64}$/, "slug must be lowercase alphanumeric with hyphens, max 64 chars"))
  ),
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
});

export const UpdateAppSchema = v.object({
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
});

export type CreateAppInput = v.InferOutput<typeof CreateAppSchema>;
export type UpdateAppInput = v.InferOutput<typeof UpdateAppSchema>;
```

Use `v.safeParse` in route handlers — on failure return `400` with the flattened valibot issues:

```ts
const result = v.safeParse(CreateAppSchema, await c.req.json());
if (!result.success) {
  return c.json({ error: v.flatten(result.issues) }, 400);
}
const input = result.output;
```

### `POST /api/apps` Flow

```
1.  v.safeParse(CreateAppSchema, body) — 400 on failure
2.  id = crypto.randomUUID().replaceAll("-", "")
3.  slug = input.slug ?? id
4.  Get AppDO stub: env.APP_DO.get(env.APP_DO.idFromName(id))
5.  AppDO.init(id, "default")                         ← stores appCtx in DO KV storage
6.  Write row to RegistryDO with up to 5 retries      ← makes app discoverable before codegen
      { id, slug, description, total_versions: 0, created_at, last_updated: created_at }
      return 500 if all retries exhausted
7.  Call AI Gateway to generate code (see Milestone 6)
8.  AppDO.createVersion(id, slug, description, code, prompt=description)  ← inserts meta + v1
9.  writeAppRecord(appRecord, env)                    ← KV write
10. ctx.waitUntil(registry.upsertApp({ total_versions: 1, last_updated: ... }))  ← async stat bump
11. Return 201 with AppRecord
```

### `PUT /api/apps/:id` Flow

```
1. v.safeParse(UpdateAppSchema, body) — 400 on failure
2. getAppRecord(id, env) — 404 if not found
3. Call AI Gateway with description + previous code as context
4. AppDO.createVersion(id, slug, description, newCode, prompt=description)
5. writeAppRecord(updatedRecord, env)
6. ctx.waitUntil(registry.upsertApp(...))
7. Return 200 with updated AppRecord
```

### AppDO Stub Access Pattern

Each app's DO is identified by `idFromName(appId)` — the stable 32-char hex ID, not the slug.

---

## Milestone 6 — AI Gateway + Code Generation

**Goal**: A `generateCode(description, previousCode?, env)` function that calls Claude Sonnet 4.6 via the Cloudflare AI Gateway and returns a validated code string.

### AI Gateway URL

```
https://gateway.ai.cloudflare.com/v1/{CF_ACCOUNT_ID}/{AI_GATEWAY_ID}/anthropic/v1/messages
```

Called with the Anthropic API format (using `fetch` directly or `@anthropic-ai/sdk` with a custom `baseURL`).

### System Prompt

```
You are a Cloudflare Worker code generator. Output ONLY valid JavaScript — no markdown, no code fences, no explanation.

The code must:
- Import WorkerEntrypoint from "cloudflare:workers"
- Export a named class: export class DynamicHandler extends WorkerEntrypoint
- Implement: async fetch(request) { ... return new Response(...); }
- Use only Web Standard APIs (Request, Response, URL, Headers, fetch, crypto, etc.)
- Not import any external modules or use require()
- Return appropriate HTTP status codes and JSON responses
- Handle errors gracefully with try/catch
```

For updates, append to the user message:
```
Previous version of the code (modify it to satisfy the new description):
```{previousCode}```
```

### Response Validation

After receiving the generated string:
1. Check it contains `export class DynamicHandler`
2. Check it contains `async fetch(`
3. If validation fails: retry once with an error correction prompt, then return 422 if still invalid

### Model Config

```ts
{
  model: "claude-sonnet-4-6",
  max_tokens: 4096,
  messages: [{ role: "user", content: description }],
  system: SYSTEM_PROMPT,
}
```

---

## Milestone 7 — Execution Plane (Dynamic Workers)

**Goal**: The `/apps/:id/*` route that loads app code and runs it via the Dynamic Workers loader.

> For now the path segment is the app ID. Slug-based routing (`/apps/:slug/*`) will be added in a follow-up once the `slug:{slug}` KV entry is introduced.

### Handler Flow

```
1. Extract appId from path param
2. getAppRecord(appId, env) — in-memory cache → KV → AppDO
3. Return 404 if not found
4. Build Dynamic Worker cache key: `${appRecord.id}_${appRecord.current.created_at}`
5. Get stub: env.LOADER.get(key, async () => ({
     compatibilityDate: "2026-05-27",
     mainModule: "handler.js",
     modules: { "handler.js": appRecord.current.code }
   }))
6. Rewrite request URL: strip "/apps/:id" prefix
   - "/apps/{id}/todos" → "/todos"
   - "/apps/{id}" → "/"
7. const forwardedRequest = new Request(newUrl, request)
8. return stub.getEntrypoint("DynamicHandler").fetch(forwardedRequest)
```

### Dynamic Worker Cache Key

`${appId}_${created_at}` — unique per version. Same version across requests hits the same cached isolate. New version (new `created_at`) produces a new key, forcing a fresh compile; the old isolate is GC'd by the runtime.

### Error Handling

- Dynamic Worker throws → catch, return 502 with error detail
- Code fails to load/compile → return 502
- App not found → 404

---

## Milestone 8 — End-to-End Wiring + Tests

**Goal**: All routes tested with Vitest + `@cloudflare/vitest-pool-workers`, and the full flow exercised manually via `wrangler dev`.

### Test Coverage

| Scenario | Type |
|---|---|
| `POST /api/apps` creates app with auto-generated ID | Integration |
| `POST /api/apps` with explicit slug stores slug in AppRecord | Integration |
| `POST /api/apps` with invalid slug returns 400 (valibot) | Integration |
| `POST /api/apps` with missing description returns 400 (valibot) | Integration |
| `GET /api/apps/:id` returns current version | Integration |
| `PUT /api/apps/:id` adds new version and updates KV | Integration |
| `GET /api/apps/:id/history` returns all versions | Integration |
| `GET /apps/:id/` invokes generated handler | Integration |
| In-memory cache serves stale-within-TTL requests without KV hit | Unit |
| KV cache miss falls back to AppDO | Unit |
| Code validation rejects missing `DynamicHandler` export | Unit |
| URL prefix stripping is correct for root and sub-paths | Unit |

### Manual Smoke Test Sequence

```bash
# Create an app (note: execution URL uses the returned ID)
curl -X POST http://localhost:8787/api/apps \
  -H "Content-Type: application/json" \
  -d '{"slug":"hello","description":"Return a JSON greeting with a random UUID"}'
# → { "id": "abc123...", "slug": "hello", ... }

# Hit the generated app via ID
curl http://localhost:8787/apps/abc123.../

# Update the app
curl -X PUT http://localhost:8787/api/apps/abc123... \
  -H "Content-Type: application/json" \
  -d '{"description":"Return a JSON greeting with a random UUID and current ISO timestamp"}'

# Check version history
curl http://localhost:8787/api/apps/abc123.../history
```

---

## Open Items (resolve during implementation)

| Item | Action |
|---|---|
| Dynamic Workers `wrangler.jsonc` binding key | Check CF playground repo or `wrangler` source; likely `"dynamic_workers": { "bindings": [{ "binding": "LOADER" }] }` |
| `stub.getEntrypoint("DynamicHandler").fetch(req)` vs `stub.fetch(req)` | Verify against actual Dynamic Workers beta behavior in local dev |
| KV namespace ID for local dev | Use `wrangler kv namespace create APP_KV --preview` and put the preview ID in wrangler.jsonc |
| `.dev.vars` setup | Document required vars: `ANTHROPIC_API_KEY`, `CF_ACCOUNT_ID`, `AI_GATEWAY_ID` |
| Slug-based execution routing | Deferred — add `slug:{slug}` → `id` KV entry in management API writes, then extend `getAppRecord` and the `/apps/:idOrSlug/*` route to resolve slugs |
| Rate limiting on codegen endpoint | Not in scope for initial implementation; add after smoke tests pass |
