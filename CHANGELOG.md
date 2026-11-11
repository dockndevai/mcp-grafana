# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-11-11

### Security
- **Approval no longer fails open on timeout.** The human-approval prompt used the MCP SDK's default
  60 s request timeout, and a timeout fell through to "approved" (the `GRAFANA_ALLOW_DELETE` gate had
  already passed). A prompt nobody answered therefore auto-approved a destructive operation. A timeout is
  now a refusal, and the wait defaults to 5 minutes.

- **Folder checks on deletes now fail closed.** `delete_dashboard` swallowed a failed folder lookup and
  carried on with no folder, so a transient Grafana error or permission failure skipped the
  `GRAFANA_PROTECTED_FOLDERS` and `GRAFANA_FOLDER_ALLOWLIST` checks and let the delete through. It is now
  refused with a clear error.
- **`delete_folder` matches protected folders by title as well as UID.** It passed only the UID to the
  policy, so a title in `GRAFANA_PROTECTED_FOLDERS` never matched. `delete_dashboard` likewise passed only
  one of the folder's UID/title. Both now check every identifier (protected if any matches; allowed if any
  is allowlisted); `delete_folder` looks the folder up and refuses if it cannot.
- **`delete_annotation` is folder-scoped.** An annotation attached to a dashboard in a protected (or
  non-allowlisted) folder can no longer be deleted: the annotation's `dashboardUID` is resolved to its
  folder first. Organisation-wide annotations are unaffected; an annotation or dashboard that cannot be
  resolved, or one tied to a dashboard by numeric id only, is refused.

### Added
- **Approvals are bound to the exact action.** The prompt shows the tool, the full (secret-redacted)
  arguments and a fingerprint; every approval and refusal is written to the audit log as
  `"audit":"approval"` with the fingerprint, resource version and `approvedBy` (`human` / `flag-only`).
- **Approvals are bound to the target's version.** `delete_dashboard`, `delete_folder` and
  `delete_annotation` read a version token before the prompt and again after the human answers, and refuse
  if it changed (dashboard uid/id/`version`/folder; folder id/uid/title/parent/creation time; annotation
  id/dashboard/panel/times/text/tags). The folder token does not cover the folder's contents.
- `GRAFANA_REQUIRE_HUMAN_APPROVAL=true` — refuse destructive ops when the client cannot elicit.
- `delete_folder` asks the human to type the folder UID.

### Changed
- `npm audit fix` (lockfile only) moved the transitive `@hono/node-server` 2.1.1 → 2.1.6, clearing the moderate advisory GHSA-rmxm-3fg6-px4f; `npm audit --omit=dev` now reports 0 vulnerabilities.

Tracking issue: https://github.com/dockndevai/mcp-core/issues/1

## [0.3.5] - 2026-11-09

### Changed
- Routine weekly dependency maintenance: `npm audit --audit-level=high` reported 0 high/critical advisories. The pre-existing moderate `@hono/node-server` advisory (GHSA-rmxm-3fg6-px4f, transitive via `@modelcontextprotocol/sdk`) remains below this pass's high/critical action threshold and is left as-is. Took the safe in-range minor bump for `vitest` (5.0.5 → 5.1.0, dev-only); no direct dependency crossed a major version boundary. `npm audit` reports 0 new vulnerabilities. No behavior change.

## [0.3.4] - 2026-11-02

### Changed
- Routine dependency maintenance: `npm audit --audit-level=high` reported 0 high/critical advisories. A pre-existing moderate advisory (`@hono/node-server` static-path middleware bypass, GHSA-rmxm-3fg6-px4f) remains, transitive via `@modelcontextprotocol/sdk`'s own pinned `@hono/node-server`; below this pass's high/critical action threshold and left as-is. Took in-range patch bump for `@types/node` (26.6.5 → 26.6.6). No behavior change.

## [0.3.3] - 2026-10-26

### Changed
- Dependency/security maintenance: `npm audit fix` cleared 2 advisories (1 high: `body-parser` DoS via trailing bytes after a compressed body — GHSA-27r3-jxmh-p828; 1 moderate: `fast-uri` scheme/host confusion — GHSA-w74x-v6f9-j3xg, GHSA-xhq7-xmqj-769h, GHSA-wjr9-j795-jxcr, GHSA-333x-w4r6-6crp). Bumped `@modelcontextprotocol/sdk` 1.32.1 → 1.32.2 (in-range patch). `npm audit` reports 0 vulnerabilities. No behavior change.

## [0.3.2] - 2026-10-19

### Changed
- Routine dependency maintenance: `npm audit --audit-level=high` reported 0 advisories; in-range patch bumps for `vitest` (5.0.3 → 5.0.5) and `zod` (4.6.6 → 4.6.7). `npm audit` reports 0 vulnerabilities. No behavior change.

## [0.3.1] - 2026-10-12

### Security
- Bump `@modelcontextprotocol/sdk` to `1.32.1` via `npm audit fix` to clear a high-severity advisory (OAuth client could send credentials to a server-chosen authorization server) along with moderate/critical transitive advisories in `fast-uri`, `hono`, `ip-address`, `proxy-addr`, and `source-map-js`. `npm audit` now reports 0 vulnerabilities.

### Changed
- Routine in-range patch bumps: `@types/node` `26.6.5`, `tsx` `4.23.15`, `vitest` `5.0.3`, `zod` `4.6.6`.

## [0.3.0] - 2026-09-29

### Added
- **Optional AI risk guard (laya-guard).** Mutating tools can consult a local [laya-guard](https://github.com/dockndevai/laya-guard) daemon that classifies each operation allow / confirm / block before it runs. Runs after the deterministic policy gates and can only *tighten*, never grant; fails closed. Off by default (`GRAFANA_GUARD_MODE=monitor|enforce`).

## [0.2.3] - 2026-09-12

### Changed
- Bring dependencies and CI to current majors: `zod` ^4, TypeScript ^7, `@types/node` ^26, `tsx` ^4.23, and GitHub Actions (checkout v7, setup-node v7, action-gh-release v3, gitleaks v3, codeql-action v4). Clears the open Dependabot updates; `npm audit` reports 0 vulnerabilities.

## [0.2.2] - 2026-09-10

### Documentation
- Add an interactive-confirmation demo GIF (`docs/confirm-demo.gif`) to the README's safe-by-default section.

## [0.2.1] - 2026-09-10

### Documentation
- Document the interactive-confirmation (MCP elicitation) behaviour in the safe-by-default section.

## [0.2.0] - 2026-09-10

### Added
- **Human-in-the-loop confirmation for destructive actions**, via MCP [elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation). When the connected client supports elicitation, `delete_dashboard`, `delete_folder`, and `delete_annotation` now pause and ask the **human** to approve the exact action before it runs — a model can echo a confirmation string, but it cannot approve a prompt shown to the user. Clients that don't advertise elicitation fall back to the existing `*_ALLOW_*` flag gate, so enabling this is never *more* permissive than before.

## [0.1.1] - 2026-09-09

### Changed
- Require **Node 22** (previously Node 20); the updated dependency tree needs Node ≥ 22.19. CI and release workflows, the Dockerfile base image, and `engines` were updated.
- Bump the test runner `vitest` to ^5.0.0.

### Security
- Refresh the dependency tree so `npm audit` reports **0 vulnerabilities**.

## [0.1.0]

### Added
- Initial release: a safe-by-default MCP server for Grafana. 17 tools across
  read/read-write/admin covering health, dashboard & folder search and reading,
  the dashboard JSON model, datasources, querying (Prometheus/Loki/SQL via the
  unified /api/ds/query), alert rules, annotations, dashboard/folder upserts, and
  deletes.
- Security model: access modes (read-only/read-write/admin), folder allowlist and
  protected folders, datasource allowlist, delete opt-in (GRAFANA_ALLOW_DELETE),
  dry-run, JSON audit logging, and datasource-secret redaction.
- MCP tool annotations derived from each tool's capability, with a test keeping
  them consistent.
- A bundled skill (grafana-dashboards-and-queries) capturing the dashboard JSON
  model, query conventions, and safe-editing rules so agents build to a
  consistent standard.
