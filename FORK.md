# Fork notes (risset/pi-langfuse)

This is a fork of [gooyoung/pi-langfuse](https://github.com/gooyoung/pi-langfuse) (MIT), branched from
upstream `v1.7.1` (`e4b6ea3`, the commit published to npm as `pi-langfuse@1.7.1`). All upstream code,
history and attribution are kept.

## Delta

One feature, kept generic so it can be proposed upstream:

- `/langfuse-context set|clear|status` attaches caller-supplied flat metadata to the session's
  later traces. See "Custom Trace Context" in `README.md`.
- New modules `src/telemetry-context.ts` and `src/context-command.ts`; small hooks in `index.ts`
  (command, `session_start`/`session_tree` restore), `src/handlers/agent.ts` (snapshot at run start)
  and `src/state.ts` (per-session cache that survives run resets). `/langfuse-status` shows the context.
- No dependency, exporter or wire-format changes. Without `/langfuse-context` calls, traces are
  identical to upstream: no new metadata keys appear.

## Compatibility

- Verified with Pi 1.5.2 (`pi --mode rpc`) and the dev dependency `@earendil-works/pi-coding-agent`
  1.0.0, Langfuse server 4.79.0 (OTel export, v2 observations API).
- The idle check relies on `ctx.isIdle()` covering runs, retries and compaction and on
  `ctx.hasPendingMessages()`, as in Pi 1.5.2.
- Rollback: reinstall upstream `npm:pi-langfuse@<version>`. Persisted `pi-langfuse.context` entries are
  inert `custom` entries that upstream ignores.

## Install from Git

```bash
pi install git:github.com/risset/pi-langfuse@<commit>
```

Pin a full commit hash. Do not load this fork alongside the npm package; they are different package
identities and both would export every trace.

## Maintenance

```bash
git fetch upstream --tags
git rebase --onto upstream/main v1.7.1 feat/telemetry-context   # or the next release tag
npm ci && npm run typecheck && npm test
```

Keep the feature in its own commits, separate from dependency upgrades or formatting. To propose it
upstream, open a PR from the feature commits only; this file and any personal conventions stay here.
