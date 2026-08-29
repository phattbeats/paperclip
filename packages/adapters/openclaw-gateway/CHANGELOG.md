# @paperclipai/adapter-openclaw-gateway

## Unreleased

### Patch Changes

- **PHA-2752:** Mint a run-bound JWT at wake-spawn so OpenClaw-routed wakes can hit `/api/agents/me/secrets/*/value`. The adapter now calls `POST /api/internal/agents/{agentId}/run-bearer` with the static claimed API key before building the wake prompt, then injects the returned JWT as `PAPERCLIP_API_KEY` in the wake env block. Falls back to the static key if the mint fails (logged via `stderr`). When the server-side endpoint is not yet available, behavior is unchanged from the previous release: issue / POST-comment / checkout still work via the session-bind + `X-Paperclip-Run-Id` path; secrets API still 403s until the server lands its side.
- New exported helper: `mintRunBoundJwtOnServer` (mirrors `bindSessionRunIdOnServer` shape; same best-effort semantics with explicit `ok`/`error` result and onLog hooks). 5s default timeout, AbortController-based, URL-encoded agentId segment.
- `buildPaperclipEnvForWake` accepts an optional `{ runBoundJwt }` so the wake env block can carry the minted JWT.
- The wake prompt now surfaces `PAPERCLIP_API_KEY=<run-bound JWT, valid for this wake only>` when a JWT was minted, with instructions telling the agent runtime to use the JWT (not the on-disk claimed key) for that wake. When no JWT was minted the prompt falls back to the pre-PHA-2752 disk-load instruction.
- Test coverage: 13 new tests covering the happy path, URL encoding, missing/empty `expiresAt`, 4xx/5xx, non-JSON body, JSON array body, missing/empty `token`, fetch throw, invalid URL, timeout abort, and onLog wiring.
- Fail loud at wake time when `adapterConfig.agentId` is null/empty and the sessionKey has no `agent:<id>:` prefix to derive from. Previously the gateway would silently fall back to OpenClaw agent `main`, misrouting wakes (e.g. Van Dam runs landing in Ledger's workspace). New `errorCode: "openclaw_gateway_agent_id_unresolved"` surfaces the unresolved config on the run. The resolved agentId (configured or derived) is logged on every wake so misroutes are visible in run output.
- New `auditOpenclawGatewayConfig` helper flags any `openclaw_gateway` agent whose `adapterConfig.agentId` does not match its `adapterConfig.sessionKey` prefix. Intended for use at agent save time (operator UI) or startup audit.
- New exported helpers: `extractAgentIdFromSessionKey`, `resolveOpenclawGatewayAgentId`, `auditOpenclawGatewayConfig`.
- Test coverage: 14 new tests covering the resolver, the audit helper, and the derived-from-sessionKey propagation path through `buildAgentParams`.

## 0.3.1

### Patch Changes

- Stable release preparation for 0.3.1
- Updated dependencies
  - @paperclipai/adapter-utils@0.3.1

## 0.3.0

### Minor Changes

- Stable release preparation for 0.3.0

### Patch Changes

- Updated dependencies
  - @paperclipai/adapter-utils@0.3.0
