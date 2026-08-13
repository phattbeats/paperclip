import { describe, expect, it } from "vitest";
import {
  auditOpenclawGatewayConfig,
  buildAgentParams,
  extractAgentIdFromSessionKey,
  resolveOpenclawGatewayAgentId,
  resolveSessionKey,
} from "./execute.js";

describe("resolveSessionKey", () => {
  it("prefixes run-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "run",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip:run:run-123");
  });

  it("prefixes issue-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: "issue-456",
      }),
    ).toBe("agent:meridian:paperclip:issue:issue-456");
  });

  it("prefixes fixed session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });

  it("does not double-prefix an already-routed session key", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "agent:meridian:paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });
});

describe("buildAgentParams", () => {
  it("strips root-level paperclip fields from gateway agent params", () => {
    expect(
      buildAgentParams({
        payloadTemplate: {
          text: "old text",
          paperclip: { stale: true },
          keep: "value",
        },
        message: "wake text",
        sessionKey: "agent:meridian:paperclip:issue:issue-456",
        runId: "run-123",
        configuredAgentId: "meridian",
        waitTimeoutMs: 30_000,
      }),
    ).toEqual({
      keep: "value",
      message: "wake text",
      sessionKey: "agent:meridian:paperclip:issue:issue-456",
      idempotencyKey: "run-123",
      agentId: "meridian",
      timeout: 30_000,
    });
  });

  it("preserves an explicit agentId and timeout from the payload template", () => {
    expect(
      buildAgentParams({
        payloadTemplate: {
          agentId: "template-agent",
          timeout: 5_000,
        },
        message: "wake text",
        sessionKey: "paperclip",
        runId: "run-123",
        configuredAgentId: "configured-agent",
        waitTimeoutMs: 30_000,
      }),
    ).toEqual({
      agentId: "template-agent",
      timeout: 5_000,
      message: "wake text",
      sessionKey: "paperclip",
      idempotencyKey: "run-123",
    });
  });

  it("propagates a derived-from-sessionKey agentId when none is configured (PHA-1888)", () => {
    expect(
      buildAgentParams({
        payloadTemplate: {},
        message: "wake text",
        sessionKey: "agent:engineer:paperclip:issue:issue-456",
        runId: "run-123",
        configuredAgentId: "engineer",
        waitTimeoutMs: 30_000,
      }),
    ).toEqual({
      message: "wake text",
      sessionKey: "agent:engineer:paperclip:issue:issue-456",
      idempotencyKey: "run-123",
      agentId: "engineer",
      timeout: 30_000,
    });
  });
});

describe("extractAgentIdFromSessionKey (PHA-1888)", () => {
  it("extracts the agent id from a fixed sessionKey", () => {
    expect(extractAgentIdFromSessionKey("agent:engineer:paperclip")).toBe("engineer");
  });

  it("extracts the agent id from an issue-scoped sessionKey", () => {
    expect(
      extractAgentIdFromSessionKey("agent:engineer:paperclip:issue:acbeac37-8f75-4033-9518-dddf89567a77"),
    ).toBe("engineer");
  });

  it("returns null for an unprefixed sessionKey", () => {
    expect(extractAgentIdFromSessionKey("paperclip:issue:acbeac37-8f75-4033-9518-dddf89567a77")).toBeNull();
  });

  it("returns null for a sessionKey that only has the prefix and no id segment", () => {
    expect(extractAgentIdFromSessionKey("agent:")).toBeNull();
    expect(extractAgentIdFromSessionKey("agent::paperclip")).toBeNull();
  });

  it("returns null for an empty or missing sessionKey", () => {
    expect(extractAgentIdFromSessionKey(null)).toBeNull();
    expect(extractAgentIdFromSessionKey(undefined)).toBeNull();
    expect(extractAgentIdFromSessionKey("")).toBeNull();
    expect(extractAgentIdFromSessionKey("   ")).toBeNull();
  });
});

describe("resolveOpenclawGatewayAgentId (PHA-1888)", () => {
  it("prefers the explicit configured agentId when set", () => {
    expect(
      resolveOpenclawGatewayAgentId({
        configuredAgentId: "engineer",
        sessionKey: "agent:ledger:paperclip:issue:issue-456",
      }),
    ).toEqual({ agentId: "engineer", source: "configured" });
  });

  it("derives agentId from the sessionKey prefix when not configured", () => {
    expect(
      resolveOpenclawGatewayAgentId({
        configuredAgentId: null,
        sessionKey: "agent:engineer:paperclip:issue:issue-456",
      }),
    ).toEqual({ agentId: "engineer", source: "sessionKey" });
  });

  it("returns null when neither the config nor the sessionKey prefix resolves", () => {
    expect(
      resolveOpenclawGatewayAgentId({
        configuredAgentId: null,
        sessionKey: "paperclip:issue:issue-456",
      }),
    ).toEqual({ agentId: null, source: null });
  });

  it("returns null when configuredAgentId is empty AND the sessionKey has no prefix", () => {
    expect(
      resolveOpenclawGatewayAgentId({
        configuredAgentId: "",
        sessionKey: "paperclip:run:run-123",
      }),
    ).toEqual({ agentId: null, source: null });
  });
});

describe("auditOpenclawGatewayConfig (PHA-1888)", () => {
  it("returns no warnings when agentId is unset and sessionKey is unset", () => {
    expect(auditOpenclawGatewayConfig({})).toEqual([]);
  });

  it("returns no warnings when agentId is unset but sessionKey prefix is derivable", () => {
    expect(
      auditOpenclawGatewayConfig({ sessionKey: "agent:engineer:paperclip" }),
    ).toEqual([]);
  });

  it("returns no warnings when configured agentId matches the sessionKey prefix", () => {
    expect(
      auditOpenclawGatewayConfig({
        agentId: "engineer",
        sessionKey: "agent:engineer:paperclip:issue:issue-456",
      }),
    ).toEqual([]);
  });

  it("flags a mismatch when configured agentId disagrees with the sessionKey prefix", () => {
    const warnings = auditOpenclawGatewayConfig({
      agentId: "ledger",
      sessionKey: "agent:engineer:paperclip:issue:issue-456",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"ledger"');
    expect(warnings[0]).toContain('"engineer"');
  });
});
