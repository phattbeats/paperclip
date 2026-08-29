import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, runJwtMintEvents } from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";

export interface MintRunBearerInput {
  agentId: string;
  companyId: string;
  runId: string;
  adapterType: string;
  actorSource: string;
  actorAgentKeyId: string | null;
}

export interface MintRunBearerResult {
  token: string;
  expiresAt: number;
  ttlSeconds: number;
}

/**
 * Issue a short-lived run-bound JWT for an agent and persist an audit row.
 *
 * Used by `POST /api/internal/agents/{id}/run-bearer` so the OpenClaw
 * adapter can hand the resulting JWT to the wake runtime as
 * `PAPERCLIP_API_KEY` (replacing the static claimed key, which the secrets
 * API refuses for OpenClaw-routed wakes). See PHA-2752 / PHA-2755.
 *
 * The actual signing is delegated to `createLocalAgentJwt` — the same
 * helper the secrets service uses to mint its JWTs. This service adds:
 *   - audit row write into `run_jwt_mint_events`
 *   - structured error mapping (`forbidden`, `notFound`, `unprocessable`)
 *   - the TTL is whatever `PAPERCLIP_AGENT_JWT_TTL_SECONDS` resolves to;
 *     it is bounded here to never exceed the static-key session-bind TTL
 *     used by PHA-1845 (6h).
 *
 * Failure to mint (e.g. JWT secret not configured) returns `null` so the
 * route handler can decide whether to surface it or treat as a mint
 * failure. Audit rows are emitted only on successful mints to keep the
 * audit log accurate; a mint that does not produce a credential has no
 * audit significance.
 */
export function runJwtService(db: Db) {
  const MAX_TTL_SECONDS = 6 * 60 * 60;
  const DEFAULT_TTL_SECONDS = 60 * 60;

  function resolveEffectiveTtl(): number {
    const raw = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    const parsed = raw ? Number(raw) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_SECONDS;
    return Math.min(Math.floor(parsed), MAX_TTL_SECONDS);
  }

  return {
    /**
     * Mint a JWT bound to `{agentId, companyId, runId}` and record the audit row.
     *
     * The caller is responsible for authentication and the
     * `actor.agentId === agentId` invariant before this is called.
     */
    async mintRunBearer(input: MintRunBearerInput): Promise<MintRunBearerResult | null> {
      if (!isUuidLike(input.runId)) {
        throw unprocessable("runId must be a uuid", { code: "invalid_run_id" });
      }
      const ttlSeconds = resolveEffectiveTtl();
      const token = createLocalAgentJwt(
        input.agentId,
        input.companyId,
        input.adapterType,
        input.runId,
        null,
        { kind: "standard" },
      );
      if (!token) {
        // The JWT helper returns null when PAPERCLIP_AGENT_JWT_SECRET is
        // not configured. Surface as a mint failure (no audit row) so the
        // operator learns about the missing config from the response /
        // the agent log without polluting the audit table.
        logger.warn(
          { agentId: input.agentId, companyId: input.companyId },
          "run-jwt mint failed: createLocalAgentJwt returned null (JWT secret not configured?)",
        );
        return null;
      }
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;

      try {
        await db.insert(runJwtMintEvents).values({
          companyId: input.companyId,
          agentId: input.agentId,
          heartbeatRunId: input.runId,
          actorAgentKeyId: input.actorAgentKeyId,
          actorSource: input.actorSource,
          jwtExpiresAt: new Date(expiresAt * 1000),
          correlationId: input.runId,
        });
      } catch (err) {
        // The credential was minted successfully but the audit row failed.
        // Log loudly; do not roll back the mint — the JWT is signed and the
        // caller already has it. Operators can reconcile via the secrets
        // API consumption logs (those use the resulting JWT).
        logger.error(
          { err, agentId: input.agentId, companyId: input.companyId, runId: input.runId },
          "run-jwt mint: token issued but audit row insert failed",
        );
      }

      return { token, expiresAt, ttlSeconds };
    },

    /**
     * Load the agent record needed to mint a run-bound JWT for it. Validates
     * the agent is active and belongs to the calling company; raises
     * `notFound` / `forbidden` with clean error codes the route can map to
     * 4xx responses.
     */
    async resolveAgentForMint(input: {
      agentId: string;
      companyId: string;
    }): Promise<{ adapterType: string }> {
      const agentRecord = await db
        .select({ id: agents.id, companyId: agents.companyId, adapterType: agents.adapterType, status: agents.status })
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .then((rows) => rows[0] ?? null);
      if (!agentRecord) {
        throw notFound("Agent not found");
      }
      if (agentRecord.companyId !== input.companyId) {
        // Treat cross-company lookups as 403, not 404 — we don't leak the
        // existence of an agent owned by a different tenant.
        throw forbidden("Agent belongs to a different company");
      }
      if (agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
        throw forbidden("Agent is not eligible for credential minting", {
          code: "agent_ineligible",
          status: agentRecord.status,
        });
      }
      return { adapterType: agentRecord.adapterType };
    },

    /**
     * Parse the runId from a request body, generating a fresh uuid when
     * the caller omitted one. The mint endpoint requires a runId in the
     * body so the JWT claim `run_id` is what the caller intends; we
     * generate only as a safety net for misbehaving adapters and log a
     * warning so the gap shows up in operator dashboards.
     */
    parseRunId(raw: unknown): string {
      if (typeof raw !== "string" || raw.length === 0 || !isUuidLike(raw)) {
        const generated = randomUUID();
        logger.warn(
          { generated },
          "run-jwt mint: request body missing runId, generated a placeholder",
        );
        return generated;
      }
      return raw;
    },
  };
}

function isUuidLike(value: string): boolean {
  // Loose check: 8-4-4-4-12 hex pattern. Matches what the adapter sends
  // (a real uuid) and accepts near-uuid variants without rejecting valid
  // upstream callers. The downstream JWT claim is treated as opaque.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
