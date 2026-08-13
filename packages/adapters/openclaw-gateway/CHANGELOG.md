# @paperclipai/adapter-openclaw-gateway

## Unreleased

### Patch Changes

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
