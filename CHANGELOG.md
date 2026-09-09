# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
