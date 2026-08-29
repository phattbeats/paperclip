import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden, unauthorized } from "../errors.js";
import { runJwtService } from "../services/index.js";

/**
 * Routes for run-bound JWT minting.
 *
 * The OpenClaw gateway adapter calls this at wake spawn to replace its
 * static claimed key with a short-lived JWT signed by the server. The
 * JWT is what the wake runtime uses as `PAPERCLIP_API_KEY`; without it,
 * the secrets API rejects `/api/agents/me/secrets/{key}/value` for
 * OpenClaw-routed agents (see PHA-2752 for the adapter half).
 *
 * Contract:
 *   POST /api/internal/agents/:agentId/run-bearer
 *     Authorization: Bearer <static pcp_… key>
 *     Content-Type: application/json
 *     { "runId": "<uuid>" }
 *   -> 200 { token, expiresAt }
 *   -> 4xx / 5xx  (adapter treats as mint failure and falls back to the
 *                  static key with a stderr log; see PHA-2752).
 *
 * Auth model:
 *   - the static key MUST resolve to the same agent whose id is in the
 *     URL path (`req.actor.source === "agent_key" && req.actor.agentId === agentId`).
 *     A key for agent A cannot mint for agent B.
 *   - the JWT secret MUST be configured server-side; if it isn't,
 *     mintRunBearer returns null and the route responds 503.
 */
export function runBearerRoutes(db: Db) {
  const router = Router();
  const svc = runJwtService(db);

  function requireAgentKeyActor(req: Request, expectedAgentId: string) {
    const actor = req.actor;
    if (!actor) throw unauthorized("Authentication required");
    if (actor.type !== "agent") {
      throw forbidden("Run-bearer mint requires an agent-key actor");
    }
    if (actor.source !== "agent_key") {
      // The OpenClaw adapter presents the static pcp_… key. A JWT-actor
      // arriving at this endpoint is a misconfiguration (the JWT was
      // minted for use against /api, not against /api/internal).
      throw forbidden("Run-bearer mint requires the static agent key (pcp_…)");
    }
    if (!actor.agentId) throw forbidden("Agent id is missing from the actor");
    if (actor.agentId !== expectedAgentId) {
      throw forbidden("Static key does not match the URL agentId", {
        code: "agent_id_mismatch",
      });
    }
    if (!actor.companyId) throw forbidden("Company id is missing from the actor");
    return actor;
  }

  router.post("/internal/agents/:agentId/run-bearer", async (req, res) => {
    const agentId = req.params.agentId;
    const actor = requireAgentKeyActor(req, agentId);

    const runId = svc.parseRunId((req.body ?? {}).runId);

    const agentLookup = await svc.resolveAgentForMint({
      agentId,
      companyId: actor.companyId!,
    });

    const minted = await svc.mintRunBearer({
      agentId,
      companyId: actor.companyId!,
      runId,
      adapterType: agentLookup.adapterType,
      actorSource: "agent_key",
      actorAgentKeyId: actor.keyId ?? null,
    });
    if (!minted) {
      // No token, no audit row. Operator-facing 503 — the secrets server
      // has no JWT secret configured. Adapter treats this as a mint
      // failure and falls back to the static key.
      res.status(503).json({
        error: "run_jwt_mint_unavailable",
        message: "Server is not configured to mint run-bound JWTs",
      });
      return;
    }
    res.json({
      token: minted.token,
      expiresAt: minted.expiresAt,
    });
  });

  return router;
}
