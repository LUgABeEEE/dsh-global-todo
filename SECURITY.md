# Security policy

## Scope

`dsh-global-todo` runs inside a local DeepSeek Harness host and manages a local list. The
parts that matter for security are:

- **The HTTP surface** (`/api/global-todo/*`). It is fenced by the host's own connection
  fence (`connection.requestRejection`) whenever that service exists, and falls back to a
  strict loopback check: loopback peer address, loopback `Host` header, and no
  `sec-fetch-site: cross-site`. A fence that throws fails closed.
- **The store file.** Plain JSON at `$DSH_HOME/global-todo/todos.json` (mode `0600` on
  write, or wherever `storePath` points). It contains whatever you or your agent typed into
  it, including document paths and URLs.
- **Dispatch.** A hand-off sends the todo's text into an agent session, which then acts
  with that session's permissions. Handing a todo to an agent is a decision with the same
  weight as typing the same text into the composer.
- **Secrets.** The plugin stores no credentials by design. URLs carrying credentials are
  refused, because the list, the activity trail and every dispatch prompt would otherwise
  retain a copy of them.

## What is *not* a vulnerability

- Reading or editing `todos.json` on the machine that owns it. That file is yours; the
  plugin is one of two writers.
- A todo's attachment pointing at a file your user account can read. Attachments are
  references, not copies: the plugin neither grants nor withholds access to the target.
- Missing authentication on the HTTP routes when the host itself is exposed without a
  fence. Deploy the host behind its own perimeter; the plugin refuses non-loopback callers
  only when the host fence is unavailable.

## Reporting

Please email the maintainer rather than opening a public issue, and include:

- the plugin version (`GET /api/global-todo/health` reports it),
- the DSH and Node versions,
- a minimal reproduction,
- what an attacker gains.

You can expect an acknowledgement within a few days and a fix or a written explanation in
the next release. Please give a reasonable window before disclosing publicly.
