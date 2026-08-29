import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * Audit log for run-bound JWT mints issued by the
 * `POST /api/internal/agents/:agentId/run-bearer` endpoint. The endpoint
 * mints a short-lived JWT signed by `createLocalAgentJwt` so the OpenClaw
 * adapter can authenticate secrets API calls during a wake; that JWT is
 * then handed back to the agent's runtime as `PAPERCLIP_API_KEY`. Because
 * a successful mint produces a credential that authenticates as the
 * agent, every mint is a credential-minting surface and needs the same
 * audit visibility as secret value access. See PHA-2755 / PHA-2752.
 *
 * Separation from `secret_access_events`: the mint row records the
 * credential *issuance*, not its subsequent use; secret_access_events
 * stays scoped to per-secret reads. A future "agent-jwt consumption"
 * event lives at `run_jwt_consumed_events` (not yet implemented).
 */
export const runJwtMintEvents = pgTable(
  "run_jwt_mint_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    // The static pcp-key id used to mint, if the caller presented one.
    // Null when the actor is a board user or other non-agent-key caller.
    actorAgentKeyId: uuid("actor_agent_key_id"),
    actorSource: text("actor_source").notNull(),
    // The minted token's `exp` claim so the audit row outlives the TTL.
    jwtExpiresAt: timestamp("jwt_expires_at", { withTimezone: true }).notNull(),
    // Stable identifier of the mint call so an end-to-end probe can correlate
    // a fetch on PHA-2683 with the row that authorized the credentials it
    // used. Populated with the run id from the request body when present;
    // falls back to a fresh uuid if the body is missing one.
    correlationId: text("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("run_jwt_mint_events_company_created_idx").on(table.companyId, table.createdAt),
    agentCreatedIdx: index("run_jwt_mint_events_agent_created_idx").on(table.agentId, table.createdAt),
    runIdx: index("run_jwt_mint_events_run_idx").on(table.heartbeatRunId),
  }),
);
