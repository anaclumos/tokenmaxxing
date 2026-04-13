# Tokenmaxxing

Runtime control panel for AI agent companies. Users sign up, bring their own LLM API keys, create agents, and run them on our infrastructure. Linear handles task management; Tokenmaxxing handles the runtime.

## What this is

A hosted SaaS where customers orchestrate teams of AI agents without managing infrastructure. The product sits between the user and their LLM providers -- we provide agent execution, cost tracking, scheduling, and an MCP marketplace. Linear (or any task manager) is the frontend for work items; Tokenmaxxing is the backend runtime.

```
Sign up (Clerk org) -> Add API keys -> Create agents -> Agents run on our infra
```

## What this is not

- Not a task manager (Linear does that)
- Not an LLM provider (customers BYOK)
- Not a self-hosted tool (we run the infrastructure)

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, React 19) |
| Styling | Tailwind CSS v4, shadcn/ui (radix-luma preset) |
| Auth | Clerk (org-only, multi-user) |
| Database | Postgres-compatible database (Neon in production, Docker Postgres locally) |
| AI | Vercel AI SDK v6 (BYOK provider factory) |
| Cache / Realtime | Upstash Redis (pub/sub, rate limiting) |
| File storage | Vercel Blob |
| Agent execution | Vercel Sandbox (Firecracker microVMs) |
| Scheduling | Vercel Cron + due_runs table |
| Encryption | AES-256-GCM envelope encryption (DEK/KEK) |
| Testing | Playwright (E2E), Docker Compose (local Postgres) |
| Package manager | Bun |
| Icons | Hugeicons |
| Corners | @squircle-js/react (iOS-style squircle clip-paths) |

---

## Architecture

```
Browser
  |
  v
Next.js App Router (Vercel)
  |
  +-- Pages (Server Components by default, small Client islands)
  |     Dashboard, Agents, Org Chart, Routines, Costs, Activity
  |     Settings (API Keys, Members, Budgets), Integrations (MCP)
  |
  +-- API Routes (/api/orgs/[orgId]/...)
  |     Explicit HTTP surface for external/API consumers
  |     Pages read data directly from the server layer instead of refetching these routes
  |
  +-- Agent Runtime
  |     AI SDK v6 -> BYOK Provider Factory -> Customer LLM APIs
  |     Budget reservation before calls, settlement after
  |     Tools provided via MCP (Linear, GitHub, etc.)
  |
  +-- Scheduler
  |     Cron tick (1min) -> due_runs table -> batch claim -> Workflow runs
  |     Reaper (10min) reclaims stale claimed runs
  |
  +-- Data Layer
        Postgres via `pg`
        Drizzle ORM, 17 tables, UUIDv7 primary keys
```

### BYOK (Bring Your Own Key)

Customers provide their own OpenAI, Anthropic, or Google API keys. We encrypt them at rest with envelope encryption and only decrypt during agent execution.

```
Customer API Key
  |  encrypted with per-org DEK (AES-256-GCM)
  v
provider_keys table (encrypted_key, dek_version)
  |  DEK encrypted with root KEK
  v
org_deks table (encrypted_dek, kek_version)
  |  KEK from ENCRYPTION_KEY env var
  v
At runtime: decrypt DEK -> decrypt API key -> create AI SDK provider
```

Every decrypt event is logged to `secret_access_log` for audit.

### MCP Marketplace

Each org gets an integration marketplace where they activate MCP servers and assign them to agents.

- **Curated catalog**: vetted MCP servers (GitHub, Linear, Slack, etc.) with auth configs
- **Custom servers**: org admins add arbitrary MCP server URLs
- **Credentials**: org-level OAuth/env-var storage with optional per-agent overrides
- **Runtime**: MCP tools resolved in the control plane (never inside Sandbox VMs)
- **Encryption**: same envelope encryption as BYOK keys

### Scheduler

Vercel Cron fires every minute. A single cron endpoint claims pending rows from `due_runs` in bounded batches (atomic `UPDATE ... LIMIT 10`). Each claimed row starts an agent execution. A separate reaper cron runs every 10 minutes to reclaim runs that were claimed but never completed.

Work enters the queue via:
- Agent heartbeat schedules
- Routine cron triggers
- Event-triggered runs (task assignment, mentions)

### Cost tracking

Since customers use their own keys, we track costs from AI SDK response data:

1. **Before** each LLM call: reserve an estimated amount in `budget_reservations`
2. **After** the call: settle with actual `inputTokens`/`outputTokens` from the AI SDK response
3. **Budget check**: `settled + reserved >= budget` stops the agent before the next call

Costs are computed using a model pricing lookup table maintained in `src/lib/ai/pricing.ts`.

---

## Database schema

17 tables across 9 schema files. Every tenant-scoped table has `org_id` with an index. All primary keys use UUIDv7 for time-sortable, index-friendly IDs.

| Table | Purpose |
|---|---|
| `agents` | AI agents with model, provider, role, hierarchy (reportsTo), budget |
| `provider_keys` | Encrypted BYOK API keys per org/provider |
| `org_deks` | Per-org Data Encryption Keys (encrypted by KEK) |
| `secret_access_log` | Audit trail for every key decrypt event |
| `cost_events` | Token usage records per agent/model |
| `budget_reservations` | Pre-call budget reservations with settle/cancel lifecycle |
| `heartbeat_runs` | Agent run records with workflow IDs and usage |
| `due_runs` | Scheduler queue with atomic batch claiming |
| `routines` | User-defined scheduled agent work |
| `routine_triggers` | Cron expressions for routines |
| `routine_runs` | Execution history for routines |
| `activity_log` | Audit log of all mutations |
| `mcp_catalog_entries` | Curated MCP server definitions (system-wide, no org_id) |
| `org_mcp_installations` | Activated MCP servers per org |
| `org_mcp_credentials` | Encrypted OAuth/env-var credentials per installation |
| `agent_mcp_assignments` | Which MCP servers are assigned to which agents |
| `agent_mcp_credential_overrides` | Per-agent credential overrides |

Connection strategy:
- **Single `pg` pool** for app routes, pages, workflows, and local tooling
- **Drizzle node-postgres driver** for all queries
- **Lazy initialization** so connections are only created when needed

---

## API routes

All routes are org-scoped. The server derives the allowed org from Clerk auth (`auth().orgId`), never from the URL path parameter alone. Path `[orgId]` is validated against the session's org membership on every request.

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/orgs/[orgId]/agents` | List/create agents |
| GET/PATCH/DELETE | `/api/orgs/[orgId]/agents/[agentId]` | Get/update/archive agent |
| GET | `/api/orgs/[orgId]/dashboard` | Aggregate counts (agents, runs, spend) |
| GET | `/api/orgs/[orgId]/costs` | Cost events + summary |
| GET | `/api/orgs/[orgId]/activity` | Activity log timeline |
| GET/POST | `/api/orgs/[orgId]/routines` | List/create routines |
| GET/POST | `/api/orgs/[orgId]/settings/keys` | List/store BYOK keys |
| DELETE | `/api/orgs/[orgId]/settings/keys` | Remove a provider key |
| GET/POST | `/api/orgs/[orgId]/mcp` | List/activate MCP installations |
| GET | `/api/mcp/catalog` | Browse curated MCP catalog |
| GET | `/api/events/[orgId]` | SSE stream (realtime updates) |
| GET | `/api/cron/tick` | Scheduler tick (claims due runs) |
| GET | `/api/cron/reaper` | Reclaims stale claimed runs |

---

## Pages

| Path | Description |
|---|---|
| `/dashboard` | Agent count, total runs, monthly spend, recent activity |
| `/agents` | Agent list with create dialog (name, model, provider, role, budget) |
| `/agents/[agentId]` | Agent profile, stats, assigned work |
| `/org-chart` | Agent hierarchy tree (reportsTo relationships) |
| `/routines` | Scheduled agent work with cron triggers |
| `/costs` | Token spend by agent/model, cost event history |
| `/activity` | Audit log timeline |
| `/integrations` | MCP marketplace (catalog, installed, custom) |
| `/integrations/[id]` | Single MCP installation config |
| `/settings` | General org settings |
| `/settings/keys` | BYOK API key management |
| `/settings/members` | Clerk org member management |
| `/settings/budgets` | Budget policies |

---

## Auth

### Production (Clerk)

Clerk org-only auth. Every user belongs to an organization. Org = company. Roles: `admin`, `member`, `viewer`.

Middleware protects all routes. Clerk `auth()` provides `userId`, `orgId`, `orgRole` on every request.

### Local development (Bypass mode)

When `BYPASS_AUTH=true` and `NEXT_PUBLIC_BYPASS_AUTH=true`:

- Middleware passes all requests through (no Clerk check)
- `auth()` returns `{ userId: "user_test", orgId: "org_test", orgRole: "org:admin" }`
- Clerk UI components replaced with static stubs
- No Clerk API keys needed

This lets the app run locally with just Docker Postgres.

---

## Local development

### Prerequisites

- Bun 1.x
- Docker (for Postgres)
- Node.js 20+

### Setup

```bash
git clone <repo>
cd tokenmaxxing
bun install

# Copy env and generate encryption key
cp .env.example .env.local
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# Paste the output as ENCRYPTION_KEY in .env.local

# Start Postgres
bun run db:up

# Push schema
bun run db:push

# Seed with test data
bun run db:seed

# Start dev server
bun run dev
```

Open http://localhost:3000. With `BYPASS_AUTH=true` you go straight to the dashboard -- no sign-in needed.

### Database commands

| Command | Action |
|---|---|
| `bun run db:up` | Start Postgres 18 in Docker |
| `bun run db:down` | Stop Postgres |
| `bun run db:push` | Push Drizzle schema to Postgres |
| `bun run db:seed` | Seed with test data (5 agents, costs, routines, MCP catalog) |
| `bun run db:studio` | Open Drizzle Studio (DB browser) |
| `bun run db:reset` | Destroy volume + restart Postgres |

### Seed data

The seed script (`src/lib/db/seed.ts`) creates a realistic org:

- **5 agents**: CEO (OpenAI gpt-5.4), CTO (Anthropic claude-sonnet-4.6), Frontend Engineer, Backend Engineer, Designer (Google gemini-2.5-flash)
- **Org chart**: CEO at top, CTO and Designer report to CEO, engineers report to CTO
- **2 routines**: daily standup review (CTO, 9am), weekly progress report (CEO, Fri 5pm)
- **5 cost events**: across agents/providers with realistic token counts
- **5 activity log entries**: agent creation events
- **2 MCP catalog entries**: GitHub (OAuth), Linear (env vars)

All IDs are deterministic UUIDs (`00000000-0000-7000-*`) so E2E tests can reference them.

---

## Testing

### E2E tests (Playwright)

```bash
# Run all tests
bun run test:e2e

# Run with browser visible
bun run test:e2e:headed

# Interactive UI mode
bun run test:e2e:ui
```

The Playwright config (`playwright.config.ts`):
- Starts a Next.js dev server with `BYPASS_AUTH=true`
- Global setup: Docker Compose up, schema push, seed
- Global teardown: keeps Postgres running for fast re-runs
- Screenshots captured at key points in `tests/screenshots/`

### Test files

| File | Covers |
|---|---|
| `navigation.spec.ts` | Redirect, sidebar links, section headers |
| `dashboard.spec.ts` | Metric cards, seed data counts, activity section |
| `agents.spec.ts` | List seed agents, create new agent, view detail |
| `costs.spec.ts` | Summary metrics, seed cost events |
| `org-chart.spec.ts` | Agent hierarchy tree |
| `routines.spec.ts` | Routine list, create dialog |
| `integrations.spec.ts` | MCP catalog, installed tab |
| `settings-keys.spec.ts` | BYOK provider key forms |
| `activity.spec.ts` | Activity timeline, seed entries |

Tests are designed for agentic development: they verify page loads, visible data from seed, CRUD flows, and capture screenshots for visual diff.

---

## Encryption

### Envelope encryption (DEK/KEK)

Provider API keys and MCP credentials are encrypted with a two-layer envelope scheme:

1. **Data Encryption Key (DEK)**: per-org, 256-bit AES-GCM key. Stored encrypted in `org_deks` table.
2. **Key Encryption Key (KEK)**: root key from `ENCRYPTION_KEY` env var (base64-encoded 32 bytes). Encrypts/decrypts DEKs.

This allows key rotation (re-encrypt DEKs with new KEK) without touching individual secrets.

### Decrypt path

Only two code paths decrypt secrets:
- `resolveOrgKeys()` in `src/lib/services/keys.ts` (agent runtime)
- `storeProviderKey()` in the same file (key storage)

Every decrypt is logged to `secret_access_log`.

### Key generation

```bash
# Generate a KEK for ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

---

## Agent runtime

The agent runtime (`src/lib/ai/agent-runtime.ts`) executes agents with budget protection:

1. Load agent config from DB
2. Decrypt BYOK API key via envelope encryption
3. Create AI SDK provider instance with the customer's key
4. Reserve budget (pre-call)
5. Call `generateText()` with the agent's model, system prompt, and tools
6. Settle budget with actual token usage
7. Return messages and usage

Tools are provided externally via `ctx.tools` (from MCP integrations, not hardcoded). The runtime caps tool loops with `stopWhen: stepCountIs(maxSteps)`.

If the LLM call fails, the budget reservation is cancelled (not settled).

---

## Project structure

```
src/
  app/
    (auth)/                         # Clerk sign-in/sign-up pages
    (board)/                        # Main app pages (sidebar layout)
      dashboard/                    # Agent count, runs, spend
      agents/                       # List + create
      agents/[agentId]/             # Detail page
      org-chart/                    # Hierarchy tree
      routines/                     # Scheduled work
      costs/                        # Token spend tracking
      activity/                     # Audit log
      integrations/                 # MCP marketplace
      settings/                     # Keys, members, budgets
    api/
      orgs/[orgId]/                 # Org-scoped REST routes
      cron/                         # Scheduler tick + reaper
      events/[orgId]/               # SSE endpoint
      mcp/                          # Catalog + OAuth callback
    layout.tsx                      # Root layout (Clerk, fonts, squircle)
    page.tsx                        # Redirect to /dashboard
  components/
    ui/                             # shadcn components (Card, Button, Dialog, etc.)
    clerk-stubs.tsx                 # Mock Clerk UI for bypass mode
    providers.tsx                   # ClerkProvider or passthrough
    squircle-box.tsx                # SquircleBox utility component
  hooks/
    use-org-id.ts                   # Returns orgId (mock in bypass mode)
    use-mobile.ts                   # Mobile breakpoint detection
  lib/
    ai/
      agent-runtime.ts             # Agent execution with budget gates
      provider-factory.ts           # BYOK: create AI SDK providers from keys
      pricing.ts                    # Model pricing lookup table
    crypto/
      keys.ts                       # AES-256-GCM envelope encryption
    db/
      index.ts                      # Neon + Drizzle client (lazy init)
      schema/                       # 9 schema files, 17 tables
      seed.ts                       # Test data seeder
    services/
      activity.ts                   # logActivity()
      costs.ts                      # Budget reservation/settlement
      keys.ts                       # resolveOrgKeys(), storeProviderKey()
      scheduler.ts                  # claimDueRuns(), reclaimStaleRuns()
    auth.ts                         # requireOrg(), validateOrgAccess()
    utils.ts                        # cn() utility
  middleware.ts                     # Clerk or bypass
tests/
  e2e/                              # 9 Playwright test files
  global-setup.ts                   # Docker + schema + seed
  global-teardown.ts                # Keeps Postgres running
docker-compose.yml                  # Postgres 18
drizzle.config.ts                   # Drizzle Kit config
playwright.config.ts                # E2E config with webServer
vercel.json                         # Cron schedules
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Production | Clerk publishable key |
| `CLERK_SECRET_KEY` | Production | Clerk secret key |
| `DATABASE_URL` | Always | Postgres connection string |
| `ENCRYPTION_KEY` | Always | Base64-encoded 32-byte KEK for envelope encryption |
| `UPSTASH_REDIS_REST_URL` | Production | Upstash Redis URL |
| `UPSTASH_REDIS_REST_TOKEN` | Production | Upstash Redis token |
| `BLOB_READ_WRITE_TOKEN` | Production | Vercel Blob token |
| `CRON_SECRET` | Production | Bearer token for cron endpoints |
| `BYPASS_AUTH` | Dev/Test | Skip Clerk auth, mock session |
| `NEXT_PUBLIC_BYPASS_AUTH` | Dev/Test | Skip Clerk UI components |

---

## Deployment

Deploy to Vercel. The cron jobs are configured in `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/cron/tick", "schedule": "* * * * *" },
    { "path": "/api/cron/reaper", "schedule": "*/10 * * * *" }
  ]
}
```

Required Vercel integrations:
- Neon Postgres (database)
- Upstash Redis (pub/sub, rate limiting)
- Clerk (auth)

---

## Design decisions

**Linear as frontend, not our own issue tracker.** Linear already does issue tracking well. Duplicating it adds complexity without value. Agents interact with Linear via the MCP marketplace.

**BYOK, not AI Gateway.** Customers use their own API keys. We track costs ourselves from AI SDK usage fields. This means we don't pay for LLM tokens, and customers keep their existing provider relationships.

**Envelope encryption for secrets.** DEK/KEK scheme allows key rotation without re-encrypting individual secrets. Narrow decrypt paths with audit logging.

**UUIDv7 primary keys.** Time-sortable, index-friendly. Generated application-side via `$defaultFn(() => uuidv7())` for Drizzle Kit compatibility.

**Due-runs table for scheduling, not cron-per-tenant.** Vercel Cron is static and per-project. A single cron tick drives a database queue with atomic batch claiming, idempotency keys, and stale run recovery.

**Squircle corners at component level.** `@squircle-js/react` applied in shadcn Card and Dialog components. Every Card and Dialog automatically gets iOS-style squircle corners. Cross-browser via JS clip-paths.

**Bypass auth for local dev.** `BYPASS_AUTH=true` lets the entire app run without Clerk keys. Mock session, mock Clerk UI stubs. E2E tests use this mode.
