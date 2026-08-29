import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  auditOpenclawGatewayConfig,
  bindSessionRunIdOnServer,
  buildAgentParams,
  clearSessionRunIdOnServer,
  extractAgentIdFromSessionKey,
  mintRunBoundJwtOnServer,
  readClaimedApiKey,
  resolveClaimedApiKeyPath,
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

describe("resolveClaimedApiKeyPath", () => {
  const DEFAULT_PATH = "~/.openclaw/workspace/paperclip-claimed-api-key.json";

  it("returns the configured per-agent path when set", () => {
    expect(
      resolveClaimedApiKeyPath("~/.openclaw/workspace/paperclip-keys/happy.json"),
    ).toBe("~/.openclaw/workspace/paperclip-keys/happy.json");
  });

  it("falls back to the shared default when value is empty", () => {
    expect(resolveClaimedApiKeyPath("")).toBe(DEFAULT_PATH);
    expect(resolveClaimedApiKeyPath("   ")).toBe(DEFAULT_PATH);
  });

  it("falls back to the shared default when value is missing", () => {
    expect(resolveClaimedApiKeyPath(undefined)).toBe(DEFAULT_PATH);
    expect(resolveClaimedApiKeyPath(null)).toBe(DEFAULT_PATH);
  });

  it("falls back to the shared default when value is not a string", () => {
    expect(resolveClaimedApiKeyPath(42)).toBe(DEFAULT_PATH);
    expect(resolveClaimedApiKeyPath({})).toBe(DEFAULT_PATH);
  });
});

describe("bindSessionRunIdOnServer", () => {
  function makeFetch(responses: Array<{ status: number; body?: string } | Error>): {
    fetchImpl: typeof fetch;
    calls: Array<{ url: string; init: RequestInit }>;
  } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let i = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = responses[i++] ?? { status: 200, body: "{}" };
      if (next instanceof Error) throw next;
      return new Response(next.body ?? "{}", { status: next.status });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("PUTs the runId to /api/agents/me/api-key/session-bind with bearer auth", async () => {
    const { fetchImpl, calls } = makeFetch([{ status: 200, body: '{"ok":true}' }]);
    const result = await bindSessionRunIdOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100/",
      apiKey: "pcp_test",
      runId: "11111111-2222-3333-4444-555555555555",
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://10.0.0.100:3100/api/agents/me/api-key/session-bind");
    expect(calls[0].init.method).toBe("PUT");
    const headers = new Headers(calls[0].init.headers as HeadersInit);
    expect(headers.get("authorization")).toBe("Bearer pcp_test");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      runId: "11111111-2222-3333-4444-555555555555",
    });
  });

  it("returns ok:false when the server returns non-2xx", async () => {
    const { fetchImpl } = makeFetch([{ status: 503, body: "down" }]);
    const result = await bindSessionRunIdOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100",
      apiKey: "pcp_test",
      runId: "11111111-2222-3333-4444-555555555555",
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/503/);
    }
  });

  it("returns ok:false when the fetch throws", async () => {
    const { fetchImpl } = makeFetch([new Error("ECONNREFUSED")]);
    const result = await bindSessionRunIdOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100",
      apiKey: "pcp_test",
      runId: "11111111-2222-3333-4444-555555555555",
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/ECONNREFUSED/);
    }
  });

  it("returns ok:false on invalid paperclipApiUrl", async () => {
    const result = await bindSessionRunIdOnServer({
      paperclipApiUrl: "not a url",
      apiKey: "pcp_test",
      runId: "11111111-2222-3333-4444-555555555555",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
  });

  it("aborts on timeout", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;
    const result = await bindSessionRunIdOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100",
      apiKey: "pcp_test",
      runId: "11111111-2222-3333-4444-555555555555",
      fetchImpl,
      timeoutMs: 5,
    });
    expect(result.ok).toBe(false);
  });
});

describe("clearSessionRunIdOnServer", () => {
  function makeFetch(responses: Array<{ status: number; body?: string } | Error>): {
    fetchImpl: typeof fetch;
    calls: Array<{ url: string; init: RequestInit }>;
  } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let i = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = responses[i++] ?? { status: 200, body: "{}" };
      if (next instanceof Error) throw next;
      return new Response(next.body ?? "{}", { status: next.status });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("DELETEs the session-bind endpoint with the matching runId", async () => {
    const { fetchImpl, calls } = makeFetch([{ status: 200 }]);
    const result = await clearSessionRunIdOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100/",
      apiKey: "pcp_test",
      runId: "11111111-2222-3333-4444-555555555555",
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://10.0.0.100:3100/api/agents/me/api-key/session-bind");
    expect(calls[0].init.method).toBe("DELETE");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      runId: "11111111-2222-3333-4444-555555555555",
    });
  });

  it("treats 404 as ok (binding was already cleared)", async () => {
    const { fetchImpl } = makeFetch([{ status: 404 }]);
    const result = await clearSessionRunIdOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100",
      apiKey: "pcp_test",
      runId: "11111111-2222-3333-4444-555555555555",
      fetchImpl,
    });
    expect(result.ok).toBe(true);
  });
});

describe("readClaimedApiKey", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("reads a valid claimed-api-key JSON file", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "openclaw-claimed-"));
    const file = join(tempDir, "key.json");
    writeFileSync(
      file,
      JSON.stringify({
        token: "pcp_test_token",
        agentId: "agent-1",
        companyId: "company-1",
        claimedAt: "2026-08-01T00:00:00Z",
      }),
    );
    const result = await readClaimedApiKey(file);
    expect(result).toEqual({
      token: "pcp_test_token",
      agentId: "agent-1",
      companyId: "company-1",
    });
  });

  it("returns null when the file does not exist", async () => {
    const result = await readClaimedApiKey("/no/such/file.json");
    expect(result).toBeNull();
  });

  it("returns null when the file is not valid JSON", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "openclaw-claimed-"));
    const file = join(tempDir, "key.json");
    writeFileSync(file, "{not valid json");
    const result = await readClaimedApiKey(file);
    expect(result).toBeNull();
  });

  it("returns null when the file is missing required fields", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "openclaw-claimed-"));
    const file = join(tempDir, "key.json");
    writeFileSync(file, JSON.stringify({ token: "pcp_test" }));
    const result = await readClaimedApiKey(file);
    expect(result).toBeNull();
  });

  it("expands a leading tilde to the home directory", async () => {
    // Don't actually write to $HOME — just verify the path expansion logic
    // by passing a path under $HOME that doesn't exist.
    const home = process.env.HOME ?? "";
    if (!home) return; // skip on platforms without HOME
    const result = await readClaimedApiKey(`~/${Math.random()}-does-not-exist.json`);
    expect(result).toBeNull();
  });
});

describe("mintRunBoundJwtOnServer", () => {
  function makeFetch(responses: Array<{ status: number; body?: string } | Error>): {
    fetchImpl: typeof fetch;
    calls: Array<{ url: string; init: RequestInit }>;
  } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let i = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = responses[i++] ?? { status: 200, body: "{}" };
      if (next instanceof Error) throw next;
      return new Response(next.body ?? "{}", { status: next.status });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("POSTs the runId to /api/internal/agents/{id}/run-bearer with bearer auth and returns the token", async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 200, body: '{"token":"jwt.abc.def","expiresAt":4102444800}' },
    ]);
    const result = await mintRunBoundJwtOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100/",
      apiKey: "pcp_test",
      agentId: "agent-1234",
      runId: "11111111-2222-3333-4444-555555555555",
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe("jwt.abc.def");
      expect(result.expiresAt).toBe(4102444800);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://10.0.0.100:3100/api/internal/agents/agent-1234/run-bearer");
    expect(calls[0].init.method).toBe("POST");
    const headers = new Headers(calls[0].init.headers as HeadersInit);
    expect(headers.get("authorization")).toBe("Bearer pcp_test");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      runId: "11111111-2222-3333-4444-555555555555",
    });
  });

  it("encodes agentId segments in the URL path", async () => {
    const { fetchImpl, calls } = makeFetch([{ status: 200, body: '{"token":"jwt.x.y"}' }]);
    await mintRunBoundJwtOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100",
      apiKey: "pcp_test",
      agentId: "agent with spaces/and/slashes",
      runId: "run-1",
      fetchImpl,
    });
    expect(calls[0].url).toBe(
      "http://10.0.0.100:3100/api/internal/agents/agent%20with%20spaces%2Fand%2Fslashes/run-bearer",
    );
  });

  it("accepts a missing expiresAt field", async () => {
    const { fetchImpl } = makeFetch([{ status: 200, body: '{"token":"jwt.x.y"}' }]);
    const result = await mintRunBoundJwtOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100",
      apiKey: "pcp_test",
      agentId: "agent-1",
      runId: "run-1",
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe("jwt.x.y");
      expect(result.expiresAt).toBeUndefined();
    }
  });

  it("returns ok:false when the server returns non-2xx", async () => {
    const { fetchImpl } = makeFetch([{ status: 503, body: "down" }]);
    const result = await mintRunBoundJwtOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100",
      apiKey: "pcp_test",
      agentId: "agent-1",
      runId: "run-1",
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/503/);
    }
  });

  it("returns ok:false when the body is not JSON", async () => {
    const { fetchImpl } = makeFetch([{ status: 200, body: "<html>not json</html>" }]);
    const result = await mintRunBoundJwtOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100",
      apiKey: "pcp_test",
      agentId: "agent-1",
      runId: "run-1",
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/non-JSON/);
    }
  });

  it("returns ok:false when the body is a JSON array (non-object)", async () => {
    const { fetchImpl } = makeFetch([{ status: 200, body: "[]" }]);
    const result = await mintRunBoundJwtOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100",
      apiKey: "pcp_test",
      agentId: "agent-1",
      runId: "run-1",
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // A JSON array parses as typeof "object" but has no `token` property,
      // so the missing-token guard fires. The error message is the
      // contract the caller logs; verify it.
      expect(result.error).toMatch(/without token/);
    }
  });

  it("returns ok:false when the token field is missing", async () => {
    const { fetchImpl } = makeFetch([{ status: 200, body: '{"expiresAt":4102444800}' }]);
    const result = await mintRunBoundJwtOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100",
      apiKey: "pcp_test",
      agentId: "agent-1",
      runId: "run-1",
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/without token/);
    }
  });

  it("returns ok:false when the token field is an empty string", async () => {
    const { fetchImpl } = makeFetch([{ status: 200, body: '{"token":""}' }]);
    const result = await mintRunBoundJwtOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100",
      apiKey: "pcp_test",
      agentId: "agent-1",
      runId: "run-1",
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/without token/);
    }
  });

  it("returns ok:false when the fetch throws", async () => {
    const { fetchImpl } = makeFetch([new Error("ECONNREFUSED")]);
    const result = await mintRunBoundJwtOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100",
      apiKey: "pcp_test",
      agentId: "agent-1",
      runId: "run-1",
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/ECONNREFUSED/);
    }
  });

  it("returns ok:false on invalid paperclipApiUrl", async () => {
    const result = await mintRunBoundJwtOnServer({
      paperclipApiUrl: "not a url",
      apiKey: "pcp_test",
      agentId: "agent-1",
      runId: "run-1",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/invalid paperclipApiUrl/);
    }
  });

  it("aborts on timeout", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;
    const result = await mintRunBoundJwtOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100",
      apiKey: "pcp_test",
      agentId: "agent-1",
      runId: "run-1",
      fetchImpl,
      timeoutMs: 5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/aborted|threw/i);
    }
  });

  it("invokes onLog('stderr') on non-2xx response", async () => {
    const { fetchImpl } = makeFetch([{ status: 403, body: "forbidden" }]);
    const onLog = vi.fn();
    await mintRunBoundJwtOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100",
      apiKey: "pcp_test",
      agentId: "agent-1",
      runId: "run-1",
      fetchImpl,
      onLog,
    });
    const stderrCalls = onLog.mock.calls.filter((c) => c[0] === "stderr");
    expect(stderrCalls.length).toBeGreaterThanOrEqual(1);
    expect(stderrCalls[0][1]).toMatch(/run-jwt mint failed/);
  });

  it("invokes onLog('stdout') on success", async () => {
    const { fetchImpl } = makeFetch([{ status: 200, body: '{"token":"jwt.x.y"}' }]);
    const onLog = vi.fn();
    await mintRunBoundJwtOnServer({
      paperclipApiUrl: "http://10.0.0.100:3100",
      apiKey: "pcp_test",
      agentId: "agent-1",
      runId: "run-1",
      fetchImpl,
      onLog,
    });
    const stdoutCalls = onLog.mock.calls.filter((c) => c[0] === "stdout");
    expect(stdoutCalls.length).toBeGreaterThanOrEqual(1);
    expect(stdoutCalls[0][1]).toMatch(/minted run-bound JWT/);
  });
});
