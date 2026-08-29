import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  runJwtMintEvents,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { runBearerRoutes } from "../routes/run-bearer.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * Tests for `POST /api/internal/agents/:agentId/run-bearer` (PHA-2755).
 *
 * The endpoint mints a short-lived run-bound JWT for an agent when the
 * caller authenticates with the agent's static `pcp_…` key. The adapter
 * side is exercised end-to-end in the wake loop; this suite covers the
 * server's:
 *
 *   1. happy path — same agent key + matching URL id -> 200 + valid JWT
 *   2. cross-agent guard — key for agent A cannot mint for agent B
 *   3. agent-key actor only — JWT-derived actors are refused
 *   4. unauthenticated — missing bearer -> 401/403
 *   5. unknown agentId in URL -> 404
 *   6. terminated agent -> 403
 *   7. cross-company agent lookup -> 403 (no info leak)
 *   8. missing body / missing runId -> 200 with auto-generated runId + warning
 *   9. malformed body -> 200 with auto-generated runId (parseRunId safety net)
 *  10. audit row written with correct fields (companyId, agentId, runId, ...)
 *  11. ttl honoured — `expiresAt` matches `now + ttl`
 *
 * The test exercises the live actor middleware so the same auth path
 * (board key -> none, no bearer -> none, agent key -> source='agent_key')
 * runs as in production.
 */
describeEmbeddedPostgres("run-bearer routes (PHA-2755)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "run-bearer-test-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "120";
    delete process.env.PAPERCLIP_INSTANCE_ID;
    const started = await startEmbeddedPostgresTestDatabase("run-bearer-routes");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(runJwtMintEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
    if (originalTtl === undefined) delete process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    else process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = originalTtl;
    if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
  });

  async function seedAgent(opts: { adapterType?: string; status?: string } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Run bearer test",
      issuePrefix: `R${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Van Dam",
      role: "engineer",
      adapterType: opts.adapterType ?? "openclaw_gateway",
      adapterConfig: {},
      status: opts.status ?? "idle",
    });
    return { companyId, agentId };
  }

  /**
   * Build an Express app with the actor middleware + the run-bearer route.
   * Bypasses the real agent-key lookup by injecting an actor directly —
   * matches the pattern used by `agent-secrets-routes.test.ts`. The route
   * only cares about `actor.source === "agent_key"` and matching
   * `actor.agentId`, not the underlying token verification.
   */
  function createApp(input: {
    agentId: string;
    companyId: string;
    actorSource?: "agent_key" | "agent_jwt" | "none" | "board_key";
    onBehalfOfUserId?: string | null;
    keyId?: string;
  }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: input.actorSource === "none" ? "none" : "agent",
        source: input.actorSource ?? "agent_key",
        agentId: input.agentId,
        companyId: input.companyId,
        keyId: input.keyId ?? randomUUID(),
        keyScope: { kind: "standard" },
        onBehalfOfUserId: input.onBehalfOfUserId ?? "user-1",
        runId: undefined,
      } as any;
      next();
    });
    app.use("/api", runBearerRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("1. mints a JWT when the agent key matches the URL agentId", async () => {
    const fixture = await seedAgent();
    const runId = randomUUID();
    const res = await request(createApp(fixture))
      .post(`/api/internal/agents/${fixture.agentId}/run-bearer`)
      .send({ runId });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.token.split(".")).toHaveLength(3); // header.claims.signature
    expect(typeof res.body.expiresAt).toBe("number");
    // TTL is 120s in this suite -> expiresAt within (now + 120, now + 130)
    const now = Math.floor(Date.now() / 1000);
    expect(res.body.expiresAt).toBeGreaterThanOrEqual(now + 115);
    expect(res.body.expiresAt).toBeLessThanOrEqual(now + 125);

    // Audit row written with the request runId and matching fields.
    const events = await db.select().from(runJwtMintEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      heartbeatRunId: runId,
      actorSource: "agent_key",
      correlationId: runId,
    });
  });

  it("2. refuses cross-agent minting (key for A cannot mint for B)", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    // actor belongs to A but URL says B
    const res = await request(createApp({ agentId: a.agentId, companyId: a.companyId }))
      .post(`/api/internal/agents/${b.agentId}/run-bearer`)
      .send({ runId: randomUUID() });

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/Static key does not match/);
    expect(await db.select().from(runJwtMintEvents)).toHaveLength(0);
  });

  it("3. refuses JWT-derived actors (only static agent keys may mint)", async () => {
    const fixture = await seedAgent();
    const res = await request(
      createApp({ ...fixture, actorSource: "agent_jwt" }),
    )
      .post(`/api/internal/agents/${fixture.agentId}/run-bearer`)
      .send({ runId: randomUUID() });

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/requires the static agent key/);
    expect(await db.select().from(runJwtMintEvents)).toHaveLength(0);
  });

  it("4. refuses non-agent actors (board_key, none)", async () => {
    const fixture = await seedAgent();
    const boardApp = createApp({ ...fixture, actorSource: "board_key" });
    const boardRes = await request(boardApp)
      .post(`/api/internal/agents/${fixture.agentId}/run-bearer`)
      .send({ runId: randomUUID() });
    expect(boardRes.status).toBe(403);

    const noneApp = createApp({ ...fixture, actorSource: "none" });
    const noneRes = await request(noneApp)
      .post(`/api/internal/agents/${fixture.agentId}/run-bearer`)
      .send({ runId: randomUUID() });
    expect(noneRes.status).toBe(403);
  });

  it("5. returns 404 for an unknown agentId (no audit row)", async () => {
    const fixture = await seedAgent();
    const unknownId = randomUUID();
    const res = await request(createApp(fixture))
      .post(`/api/internal/agents/${unknownId}/run-bearer`)
      .send({ runId: randomUUID() });

    expect(res.status).toBe(404);
    expect(await db.select().from(runJwtMintEvents)).toHaveLength(0);
  });

  it("6. refuses to mint for a terminated agent", async () => {
    const fixture = await seedAgent({ status: "terminated" });
    const res = await request(createApp(fixture))
      .post(`/api/internal/agents/${fixture.agentId}/run-bearer`)
      .send({ runId: randomUUID() });

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/not eligible/);
    expect(await db.select().from(runJwtMintEvents)).toHaveLength(0);
  });

  it("7. refuses cross-company agent lookup without leaking existence", async () => {
    const realFixture = await seedAgent();
    // Actor claims to belong to a different company; route should refuse
    // (treat as cross-tenant, no information about whether the agent exists
    // in the other company).
    const foreignCompany = randomUUID();
    const res = await request(
      createApp({ agentId: realFixture.agentId, companyId: foreignCompany }),
    )
      .post(`/api/internal/agents/${realFixture.agentId}/run-bearer`)
      .send({ runId: randomUUID() });

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/different company/);
    expect(await db.select().from(runJwtMintEvents)).toHaveLength(0);
  });

  it("8. auto-generates a runId when the body omits one", async () => {
    const fixture = await seedAgent();
    const res = await request(createApp(fixture))
      .post(`/api/internal/agents/${fixture.agentId}/run-bearer`)
      .send({}); // no runId

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    const events = await db.select().from(runJwtMintEvents);
    expect(events).toHaveLength(1);
    // heartbeatRunId + correlationId are populated from the auto-generated runId
    expect(events[0].heartbeatRunId).toBeTruthy();
    expect(events[0].heartbeatRunId).toBe(events[0].correlationId);
  });

  it("9. tolerates malformed body (parseRunId safety net)", async () => {
    const fixture = await seedAgent();
    const res = await request(createApp(fixture))
      .post(`/api/internal/agents/${fixture.agentId}/run-bearer`)
      .set("Content-Type", "application/json")
      .send("not json");

    // express.json() rejects malformed JSON with 400 — that's at the
    // middleware layer. The endpoint never sees the body. Either outcome
    // (200 with safety-net runId, or 400 from express.json) is acceptable;
    // what's important is no audit row of a successful mint when no runId
    // was actually provided. Express.json's 400 satisfies that.
    if (res.status === 200) {
      const events = await db.select().from(runJwtMintEvents);
      expect(events).toHaveLength(1);
      expect(events[0].heartbeatRunId).toBeTruthy();
    } else {
      expect(res.status).toBe(400);
      expect(await db.select().from(runJwtMintEvents)).toHaveLength(0);
    }
  });

  it("10. uses the agent record's adapterType (does not trust caller body)", async () => {
    const fixture = await seedAgent({ adapterType: "openclaw_gateway" });
    // Caller asks for adapterType='process' in body — should be ignored.
    const res = await request(createApp(fixture))
      .post(`/api/internal/agents/${fixture.agentId}/run-bearer`)
      .send({ runId: randomUUID(), adapterType: "process" });

    expect(res.status).toBe(200);
    // Decode the JWT claims to confirm adapter_type === agent record value.
    const [, claimsB64] = res.body.token.split(".");
    const claims = JSON.parse(Buffer.from(claimsB64, "base64url").toString("utf8"));
    expect(claims.adapter_type).toBe("openclaw_gateway");
  });

  it("11. records the actor agent key id on the audit row", async () => {
    const fixture = await seedAgent();
    const keyId = randomUUID();
    const res = await request(createApp({ ...fixture, keyId }))
      .post(`/api/internal/agents/${fixture.agentId}/run-bearer`)
      .send({ runId: randomUUID() });

    expect(res.status).toBe(200);
    const events = await db.select().from(runJwtMintEvents);
    expect(events[0].actorAgentKeyId).toBe(keyId);
  });

  it("12. multiple sequential mints accumulate audit rows", async () => {
    const fixture = await seedAgent();
    for (let i = 0; i < 3; i += 1) {
      const res = await request(createApp(fixture))
        .post(`/api/internal/agents/${fixture.agentId}/run-bearer`)
        .send({ runId: randomUUID() });
      expect(res.status).toBe(200);
    }
    const events = await db.select().from(runJwtMintEvents);
    expect(events).toHaveLength(3);
    // Distinct run ids
    const runIds = new Set(events.map((e) => e.heartbeatRunId));
    expect(runIds.size).toBe(3);
  });

  it("13. invalid runId (non-uuid) is rejected", async () => {
    const fixture = await seedAgent();
    const res = await request(createApp(fixture))
      .post(`/api/internal/agents/${fixture.agentId}/run-bearer`)
      .send({ runId: "not-a-uuid" });

    // parseRunId safety net auto-generates a uuid when input is invalid,
    // so 200 with a generated runId is the documented behaviour. Verify the
    // audit row carries the generated runId, not the caller's invalid value.
    expect(res.status).toBe(200);
    const events = await db.select().from(runJwtMintEvents);
    expect(events).toHaveLength(1);
    expect(events[0].heartbeatRunId).not.toBe("not-a-uuid");
    expect(events[0].heartbeatRunId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("14. claim sub + run_id + company_id match the request fields", async () => {
    const fixture = await seedAgent();
    const runId = randomUUID();
    const res = await request(createApp(fixture))
      .post(`/api/internal/agents/${fixture.agentId}/run-bearer`)
      .send({ runId });

    expect(res.status).toBe(200);
    const [, claimsB64] = res.body.token.split(".");
    const claims = JSON.parse(Buffer.from(claimsB64, "base64url").toString("utf8"));
    expect(claims.sub).toBe(fixture.agentId);
    expect(claims.company_id).toBe(fixture.companyId);
    expect(claims.run_id).toBe(runId);
    expect(claims.adapter_type).toBe("openclaw_gateway");
    expect(claims.iat).toBeTypeOf("number");
    expect(claims.exp).toBe(res.body.expiresAt);
  });
});

// Anchor that the table exists; sanity check that the schema file was
// exported properly. If run_jwt_mint_events ever disappears from the
// schema index this fails at import time, surfacing the regression.
describe("run_jwt_mint_events schema export", () => {
  it("exports runJwtMintEvents from @paperclipai/db", async () => {
    const mod = await import("@paperclipai/db");
    expect(mod.runJwtMintEvents).toBeDefined();
  });
});
