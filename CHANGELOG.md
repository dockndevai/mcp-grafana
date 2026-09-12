# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
