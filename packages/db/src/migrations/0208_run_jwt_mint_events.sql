CREATE TABLE IF NOT EXISTS "run_jwt_mint_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "heartbeat_run_id" uuid,
  "actor_agent_key_id" uuid,
  "actor_source" text NOT NULL,
  "jwt_expires_at" timestamp with time zone NOT NULL,
  "correlation_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
ALTER TABLE "run_jwt_mint_events" ADD CONSTRAINT "run_jwt_mint_events_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "run_jwt_mint_events" ADD CONSTRAINT "run_jwt_mint_events_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "run_jwt_mint_events" ADD CONSTRAINT "run_jwt_mint_events_heartbeat_run_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "heartbeat_runs"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_jwt_mint_events_company_created_idx" ON "run_jwt_mint_events" ("company_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_jwt_mint_events_agent_created_idx" ON "run_jwt_mint_events" ("agent_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_jwt_mint_events_run_idx" ON "run_jwt_mint_events" ("heartbeat_run_id");
