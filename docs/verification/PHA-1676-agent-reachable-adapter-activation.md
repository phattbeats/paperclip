# PHA-1676 — verification results (agent-reachable adapter install + reload)

**Verified against:** `phattbeats/paperclip` @ `85723a11` (head of `agent-reachable-adapter-activation`, the head of upstream PR paperclipai/paperclip#10706)
**Date:** 2026-08-03
**Run by:** Vision Quest, from inside the `paperclip` container (no Unraid shell used)

## Headline

Steps 3–6 did **not** need a host shell or a docker image build. The routes under
test are server code; they were verified by booting the fork branch **from source**
against a throwaway Postgres database and an isolated `PAPERCLIP_HOME`.

Only **step 2 (docker image build)** genuinely requires a host shell — see "Hard limit".

## What was verified (8/8 PASS)

Live server, real agent bearer token (`agent_api_keys` row), real filesystem plugin dir.

| Case | Expected | Got |
|---|---|---|
| agent: install plugin inside managed dir | 201 | 201 PASS |
| agent: install plugin outside managed dir | 403 `outside_plugins_dir` | 403 PASS |
| agent: install via symlink escape planted in managed dir | 403 `outside_plugins_dir` | 403 PASS |
| agent: install package missing `paperclip-adapter-plugin` keyword | 403 `missing_keyword` | 403 PASS |
| agent: install package with `package.json` mtime < 2s | 403 `manifest_too_recent` | 403 PASS |
| agent: reload installed external plugin | 200 `{"reloaded":true}` | 200 PASS |
| agent: reload unknown type (negative case, step 5) | 404 | 404 PASS |
| agent: DELETE adapter (must stay instance-admin) | 403 `Board access required` | 403 PASS |
| agent: reinstall (must stay instance-admin) | 403 `Board access required` | 403 PASS |

## Step 6 — reload latency

Requirement was <5s from POST to effect. Measured over 5 samples:

```
0.030s 0.031s 0.030s 0.028s 0.030s
```

**~30ms.** Roughly 160x inside the bar.

## The acceptance test that actually matters

PHA-1657's real claim is "the reload is reflected within seconds, not at the next
recreate." Proven directly by mutating plugin source on disk and reloading:

```
modelsCount BEFORE: 0
POST /api/adapters/vq_test_adapter/reload  -> 200, 0.035s
modelsCount AFTER:  3
```

New plugin code was live in the running process, with no restart and no recreate.

## Unit tests (step 1 equivalent)

Ran the PR's four test files against the fork branch:

- `adapter-routes-authz.test.ts` — PASS
- `adapter-plugin-validator.test.ts` — PASS
- `plugin-loader-entry-point-guard.test.ts` — PASS
- `adapter-routes.test.ts` — 13 failed, **environmental, not the PR**

All 13 failures are `EADDRNOTAVAIL ::1:<port>`. This container has no IPv6 `::1`
on loopback, and supertest binds `::`. **Control test: the same file fails 13/13
identically on the unmodified live `/app` tree**, so it is not caused by the PR.
31/31 of the PR's own new tests pass.

## Hard limit — step 2 (docker build) DOES need a host shell

The fork Dockerfile uses `COPY --parents` and `# syntax=docker/dockerfile:1.20`.
Verified against the real daemon through phatt-claw:

| Path | Result |
|---|---|
| `POST /build` (legacy builder) | works for normal Dockerfiles; `COPY --parents` -> `unknown flag: parents` |
| `POST /build?version=2` (BuildKit) | works; but Docker 24.0.9's **built-in** frontend also rejects `--parents` |
| external frontend via `# syntax=` | `no active sessions` — needs `/session`, which phatt-claw **403s** |

So the image build is genuinely blocked from a container and needs a
BuildKit-capable shell on phatt-raid. Everything else in PHA-1676 is done.

## Corrections to the ticket text

1. Repo is **`phattbeats/paperclip`**, not `phattbeats/paperclip-unraid` (that repo
   does not exist — 404).
2. The managed plugins dir resolves from **`PAPERCLIP_HOME`**, i.e.
   `/paperclip/adapter-plugins.json` in production — not `~/.paperclip/adapter-plugins.json`.
   (`~/.paperclip` is only the fallback when `PAPERCLIP_HOME` is unset.)
3. The guard is **`assertAgentReachableInstanceAdmin`**, not `assertBoardOrAgent`
   as the ticket and some in-code comments still say.
4. The PR is no longer a three-file diff — it is 8 files / ~1900 added lines,
   including a 463-line `adapter-plugin-validator.ts` and a 371-line
   plugin-loader entry-point guard.

## Reproducing

Boot from source, no image build:

```sh
createdb pha1676_test                    # any throwaway DB
export PAPERCLIP_HOME=<scratch>          # isolated plugins dir + config
export DATABASE_URL=<...>/pha1676_test
export PORT=3199 HOST=127.0.0.1 PAPERCLIP_DEPLOYMENT_MODE=local
cd server && ./node_modules/.bin/tsx src/index.ts
```

Deps can be satisfied by symlinking the live tree's `node_modules` — `/app` and this
branch have **byte-identical** `server/package.json` dependency sets.
