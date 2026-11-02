# Skill Library

**Improve your agent’s skills. Keep your teammates’ edits. Know exactly what ran.**

A shared workspace for teams that build and maintain AI agent skills: reusable instructions and supporting text resources. Create, review changes, publish immutable versions, and trace task results back to the exact skills used.

[中文介绍](README.zh-CN.md) · [Architecture](#how-it-works) · [Run locally](#run-locally) · [Validation](docs/acceptance/production-456-merged.md)

## The problem

A skill starts as a useful prompt. Then a second person edits it, a running task depends on it, and “just update the file” becomes risky.

- A teammate publishes while you are still editing. Which changes survive?
- An agent produces a different result after an update. Which instructions did it actually use?
- A request times out. Did it fail, or did the model finish and charge for it?

Skill Library makes these situations visible and recoverable.

| When this happens… | Skill Library helps you… |
| --- | --- |
| Someone publishes while you are writing | Keep unsaved input, see the update, and compare your draft with the base and latest version. |
| Your draft is behind the published version | Explicitly reconcile changes before publishing. Stale drafts are rejected by the server. |
| A skill changes during a task | Keep that task, its retries, and its children on their original version snapshot. New tasks use the latest version by default. |
| A remote execution becomes uncertain | Inspect the attempt and provider request ID when available, then make an informed retry decision. |
| A teammate leaves | Recheck access on requests and event streams, and close the old workspace when access is revoked. |

## One workflow, from draft to result

1. **Build a shared library.** Create a team, invite collaborators, and assign admin, contributor, or viewer roles.
2. **Edit in your own draft.** Recover saved drafts, update metadata, and add supporting text files.
3. **Publish with confidence.** Valid, current drafts become new versions immediately. Teammates receive updates without having their input replaced.
4. **Resolve changes deliberately.** Compare base, local, and published content; confirm how to combine changes. Restore an older version by creating a new draft.
5. **Follow the execution.** Inspect the selected skills, fixed versions, execution attempts, result, and failure state in one task view.

<details>
<summary><strong>See the collaboration workflow</strong></summary>

![Three-way comparison preserves local input while showing a newer published skill](docs/images/collaboration.png)

Actual product screenshot from the two-browser acceptance test. The interface is currently in Chinese; the users and content are test fixtures.

</details>

<details>
<summary><strong>See task history and execution details</strong></summary>

![Task detail showing fixed skill versions, execution attempts, and a result](docs/images/execution.png)

Actual integrated task UI. The displayed provider and result are explicitly labeled fixtures; this screenshot is not evidence of a live model call.

</details>

## How it works

A **TypeScript modular monolith** with React, Node.js, PostgreSQL, and Server-Sent Events. Identity, skill management, and execution share one database and one connection pool.

```mermaid
flowchart LR
  UI[React workspace] --> API[Authenticated HTTP API]
  API --> Skills[Skills and drafts]
  API --> Tasks[Task acceptance]
  Skills --> DB[(PostgreSQL)]
  Tasks --> DB
  DB --> Events[Committed events]
  Events -->|SSE| UI
  DB --> Worker[Execution worker]
  Worker --> Provider[Anthropic Messages API]
  Worker -->|Attempts and results| DB
```

Two transaction boundaries protect the product’s most important promises:

- **Publishing:** permission, revision, and base-version checks commit together with the immutable version, current-version pointer, updated draft, audit entry, event, and idempotency receipt.
- **Accepting a task:** the fixed version snapshot and queued execution request commit together. The external model call happens afterward, outside the transaction.

Concurrent publication from the same base has one winner. The other author keeps their draft. Execution uses bounded attempts and leases; a timed-out call that may have reached the provider becomes `uncertain` instead of being silently retried.

**Deliberate tradeoffs:** team-level locks simplify write ordering at the cost of parallel writes within one team. The initial deployment is a single app instance because OAuth pending state and rate limits are in memory. Existing skill content uses JSONB with generated relational columns and database constraints; new execution records use explicit columns. Model execution currently generates text without shell or tool access.

Explore the [database design and migrations](src/modules/persistence/README.md), [execution state machine](src/modules/execution/README.md), and [deployment runbook](docs/deployment/runbook.md).

## Run locally

Requirements: **Node.js 24+, PostgreSQL 17+, and Chrome/Chromium** for browser tests. Run commands from the repository root.

```sh
# Install the committed dependency lockfiles.
sh src/deployment/install.sh

# Use a dedicated local test cluster, not a production database.
export DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:5432/skill_library_test'
export DRILL_ADMIN_URL="$DATABASE_URL"
export PG_BIN='/path/to/postgresql-17/bin'
export CHROME_PATH='/path/to/chrome-or-chromium'

# Type checks, builds, unit/integration/browser tests, and a real restore drill.
sh src/integration/verify-release.sh
```

The test role needs permission to create schemas and temporary databases. The suite cleans up its test data. OAuth and model responses in automated tests use explicit fixtures, so real provider credentials are not required for this verification path.

To run the actual application, configure an HTTPS origin, GitHub OAuth credentials, PostgreSQL, and a metrics secret following the [deployment runbook](docs/deployment/runbook.md). Then build the product and start the server:

```sh
npm run build --prefix src/modules/product
npm run start:production --prefix src
```

Enable model execution with server-side `ANTHROPIC_API_KEY`, `EXECUTION_MODEL`, and `EXECUTION_ENABLED=true`. Missing configuration fails explicitly; there is no simulated production result fallback.

## What is verified today

**155 tests passed** in the local release acceptance on Node 24 and real PostgreSQL, including two isolated Chrome sessions. The subsequent escaped-prompt boundary fix also passed all 18 execution tests and its type check.

Coverage includes concurrent publishing, unsaved-input protection, reconnect recovery, access revocation, worker crashes, fixed-version retries and child tasks, request limits, safe logging, graceful restarts, and a real `pg_dump` / `pg_restore` drill. [Read the evidence](docs/acceptance/production-456-merged.md).

| Status | Scope |
| --- | --- |
| Implemented and locally verified | Team workflows, skill management, collaboration, execution persistence and recovery, monitoring, and backup restoration. |
| Implemented; external verification pending | GitHub OAuth with two real accounts and an actual Anthropic model execution. |
| Defined; deployment verification pending | GitHub Actions, production Docker image, public HTTPS hosting, off-host backups, and external alert delivery. |

There is no public demo URL yet. The repository includes deployment configuration and an explicit checklist for completing those external checks.

## Code map

| Location | Responsibility |
| --- | --- |
| `src/modules/product` | Workspace, skill management, and author-controlled updates |
| `src/modules/identity` | OAuth, revocable sessions, invitations, and team permissions |
| `src/modules/persistence` | SQL migrations, constraints, repositories, and transaction boundaries |
| `src/modules/broadcast` | Authenticated HTTP/SSE and durable event replay |
| `src/modules/execution` | Provider adapter, attempts, cancellation, recovery, and task UI |
| `src/modules/operations` | Configuration, limits, telemetry, and restore drills |
| `src/integration` · `src/deployment` | Application composition, release checks, and deployment |

Earlier SQLite modules remain for migration compatibility and regression tests. The production application uses PostgreSQL.
