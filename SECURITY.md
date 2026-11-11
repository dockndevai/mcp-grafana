# Security

`mcp-grafana` gives an AI agent access to a Grafana instance — dashboards, datasources and the
data behind them. Treat it like any other privileged automation and grant it the least access it
needs.

## Principles

- **Start read-only.** Leave `GRAFANA_MODE=read-only` until you need edits. In read-only mode only
  the read tools are registered — the create/update/delete tools are not exposed to the model at
  all.
- **The service-account token is the primary control.** These flags are defence in depth. The real
  boundary is the Grafana service account the server authenticates as: it carries its own role
  (Viewer / Editor / Admin) and org scope. Issue the narrowest token that works — a **Viewer** token
  for read-only use means even a bug or a prompt injection cannot write.
- **Capabilities are gated by mode.** Every tool declares a capability (`read` / `write` / `admin`).
  A tool is registered only if the mode allows its capability, and each call is re-checked at
  runtime (`src/security.ts`).
- **Protect folders.** Folders listed in `GRAFANA_PROTECTED_FOLDERS` (e.g. `production`) can be read
  but never written to or deleted. Deletes resolve the target's folder first so this applies to
  deletes too: `delete_dashboard` uses the dashboard's folder, `delete_folder` the folder itself, and
  `delete_annotation` the folder of the dashboard the annotation is attached to (organisation-wide
  annotations have no folder). Folders are matched by UID **or** title, whichever form you configured.
  This **fails closed**: if the folder cannot be resolved (Grafana unreachable, an error or permission
  failure, or an annotation tied to a dashboard by numeric id only), the delete is refused rather than
  skipping the folder checks.
- **Restrict datasources.** `GRAFANA_DATASOURCE_ALLOWLIST` limits which datasources `query_datasource`
  may hit — useful to keep an agent away from sensitive datasources.
- **Gate deletes.** `delete_*` require both `admin` mode and `GRAFANA_ALLOW_DELETE=true`.
- **Require a human for destructive ops.** Set `GRAFANA_REQUIRE_HUMAN_APPROVAL=true` so `delete_dashboard`,
  `delete_folder` and `delete_annotation` are refused when the client cannot show an approval prompt.
  Each approval is bound to the exact tool and arguments (fingerprint) and to the target's version:
  a dashboard's uid, id, `version` and folder; a folder's id, uid, title, parent and creation time (not
  its contents, so dashboards added or removed while the human is deciding are not detected); an
  annotation's id, dashboard/panel, times, text and tags. If the target changed while the human was
  deciding, the action is refused. `delete_folder` also asks the human to type the folder UID. Approval
  receipts are written to the audit log (`"audit":"approval"`, with `approvedBy` = `human` or `flag-only`).
- **Preview with dry-run.** `GRAFANA_DRY_RUN=true` validates and logs write intent without executing.
- **Secrets never leave Grafana.** Datasource `secureJsonData`, `basicAuthPassword` and similar
  fields are stripped from every response — the model sees a datasource's uid/name/type/url, never
  its credentials.

## Limitations

- Folder allowlist/protection is enforced on the folder a call names (or, for deletes, the folder
  resolved from the target). Nested folders are not walked: a protected parent folder does not protect
  its sub-folders, and deleting a folder does not check the folders inside it. Querying data through
  `query_datasource` is bounded by the datasource allowlist and the token's permissions, not by folder
  rules.
- Writes check only the folder they name: `create_or_update_dashboard` checks the `folderUid` argument, not
  the folder an existing dashboard (with `overwrite`) currently lives in, and `create_annotation` does not
  check the folder of the `dashboardUID` it attaches to.
- `create_or_update_dashboard` trusts the JSON model you pass. Dashboards are versioned in Grafana,
  so a bad edit is recoverable via history; deletes are not.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a public issue.
