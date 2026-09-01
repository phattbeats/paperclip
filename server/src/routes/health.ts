import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, instanceUserRoles, invites } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { readPersistedDevServerStatus, toDevServerHealthStatus, writeDevServerRestartRequest } from "../dev-server-status.js";
import { isCloudManagedInstance } from "../middleware/auth.js";
import { logger } from "../middleware/logger.js";
import { getServerInfoSnapshot, type ServerInfoSnapshot } from "../server-info.js";
import {
  inspectDatabaseBackupHealth,
  type DatabaseBackupHealthStatus,
  type DatabaseBackupHealthWarning,
  type InspectDatabaseBackupHealthOptions,
} from "../services/database-backup-health.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { serverVersion } from "../version.js";
import { getFailedAdapterLoads } from "../adapters/plugin-loader.js";
import { findAdapterLoadStatus } from "../adapters/registry.js";

function shouldExposeFullHealthDetails(
  actorType: "none" | "board" | "agent" | null | undefined,
  deploymentMode: DeploymentMode,
) {
  if (deploymentMode !== "authenticated") return true;
  return actorType === "board" || actorType === "agent";
}

function hasDevServerStatusToken(providedToken: string | undefined) {
  const expectedToken = process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN?.trim();
  const token = providedToken?.trim();
  if (!expectedToken || !token) return false;

  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(token);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

function redactedDatabaseBackupWarning(warning: DatabaseBackupHealthWarning): DatabaseBackupHealthWarning {
  const messages: Record<DatabaseBackupHealthWarning["code"], string> = {
    database_backup_check_failed: "Database backup health check failed.",
    database_backup_last_failure: "Database backup failure marker is present.",
    database_backup_missing: "No recent database backup was found.",
    database_backup_stale: "Latest database backup is stale.",
  };
  return {
    code: warning.code,
    message: messages[warning.code],
  };
}

function redactedDatabaseBackupHealth(databaseBackup: DatabaseBackupHealthStatus) {
  return {
    enabled: databaseBackup.enabled,
    status: databaseBackup.status,
    warnings: databaseBackup.warnings.map(redactedDatabaseBackupWarning),
  };
}

export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    serverInfo?: ServerInfoSnapshot;
    databaseBackupHealth?: InspectDatabaseBackupHealthOptions;
  } = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  },
) {
  const router = Router();

  router.post("/dev-server/restart", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    if (opts.deploymentMode === "authenticated" && actorType !== "board") {
      res.status(403).json({ error: "board_access_required" });
      return;
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    if (!persistedDevServerStatus) {
      res.status(404).json({ error: "dev_server_supervisor_unavailable" });
      return;
    }

    const restartRequired =
      persistedDevServerStatus.dirty ||
      persistedDevServerStatus.changedPathCount > 0 ||
      persistedDevServerStatus.pendingMigrations.length > 0;
    if (!restartRequired) {
      res.status(409).json({ error: "restart_not_required" });
      return;
    }

    const written = writeDevServerRestartRequest({
      requestedAt: new Date().toISOString(),
      reason: "manual_restart_now",
    });
    if (!written) {
      res.status(404).json({ error: "dev_server_supervisor_unavailable" });
      return;
    }

    res.status(202).json({ status: "restart_requested" });
  });

  router.get("/", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    const exposeFullDetails = shouldExposeFullHealthDetails(
      actorType,
      opts.deploymentMode,
    );
    // serverInfo (git SHA + process start) rides on the full-details responses
    // only, so it reaches board/agent actors in authenticated mode or any caller
    // in local_trusted dev — never anonymous authenticated callers. The
    // enableServerInfoDebugView experimental flag gates the UI surface, not this
    // already access-controlled field.
    const serverInfo = opts.serverInfo ?? getServerInfoSnapshot();
    const exposeDevServerDetails =
      exposeFullDetails || hasDevServerStatusToken(req.get("x-paperclip-dev-server-status-token"));

    if (!db) {
      // Even without a DB probe, an adapter plugin load failure must flip
      // the response to 503 so plugin-dev iteration (local_trusted, no DB)
      // can detect "I shipped a plugin, did it load?" via /health.
      if (getFailedAdapterLoads().length > 0) {
        const failedLoadsEarly = getFailedAdapterLoads();
        const earlyAdapters: Record<string, { status: "loaded" | "failed"; error?: string; packageName?: string; timestamp?: string }> = {};
        for (const failure of failedLoadsEarly) {
          earlyAdapters[failure.type] = {
            status: "failed",
            error: failure.error,
            packageName: failure.packageName,
            timestamp: failure.timestamp,
          };
        }
        res.status(503).json({
          status: "unhealthy",
          version: serverVersion,
          serverVersion,
          deploymentMode: opts.deploymentMode,
          error: "adapter_plugin_load_failed",
          adapters: { failed: failedLoadsEarly.length, entries: earlyAdapters },
          ...(exposeFullDetails ? { serverInfo } : {}),
        });
        return;
      }
      res.json(
        exposeFullDetails
          ? { status: "ok", version: serverVersion, serverVersion: serverVersion, serverInfo }
          : { status: "ok", deploymentMode: opts.deploymentMode },
      );
      return;
    }

    try {
      await db.execute(sql`SELECT 1`);
    } catch (error) {
      logger.warn({ err: error }, "Health check database probe failed");
      res.status(503).json({
        status: "unhealthy",
        version: serverVersion,
        serverVersion,
        error: "database_unreachable",
        ...(exposeFullDetails ? { serverInfo } : {}),
      });
      return;
    }

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    let bootstrapInviteActive = false;
    // Cloud-managed instances have no first-admin concept: the control
    // plane owns identity and its trusted-header users are deliberately
    // never instance_admin, so the role-count gate below would report
    // bootstrap_pending forever and lock every managed tenant out at the
    // claim screen. Self-hosted deployments (no tenant server token) are
    // unaffected.
    if (opts.deploymentMode === "authenticated" && !isCloudManagedInstance()) {
      const roleCount = await db
        .select({ count: count() })
        .from(instanceUserRoles)
        .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";

      if (bootstrapStatus === "bootstrap_pending") {
        const now = new Date();
        const inviteCount = await db
          .select({ count: count() })
          .from(invites)
          .where(
            and(
              eq(invites.inviteType, "bootstrap_ceo"),
              isNull(invites.revokedAt),
              isNull(invites.acceptedAt),
              gt(invites.expiresAt, now),
            ),
          )
          .then((rows) => Number(rows[0]?.count ?? 0));
        bootstrapInviteActive = inviteCount > 0;
      }
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    let devServer: ReturnType<typeof toDevServerHealthStatus> | undefined;
    if (exposeDevServerDetails && persistedDevServerStatus && typeof (db as { select?: unknown }).select === "function") {
      const instanceSettings = instanceSettingsService(db);
      const experimentalSettings = await instanceSettings.getExperimental();
      const activeRunCount = await db
        .select({ count: count() })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]))
        .then((rows) => Number(rows[0]?.count ?? 0));

      devServer = toDevServerHealthStatus(persistedDevServerStatus, {
        autoRestartEnabled: experimentalSettings.autoRestartDevServerWhenIdle ?? false,
        activeRunCount,
      });
    }

    const databaseBackup = opts.databaseBackupHealth
      ? inspectDatabaseBackupHealth(opts.databaseBackupHealth)
      : undefined;
    const warnings = databaseBackup?.warnings.length ? databaseBackup.warnings : undefined;

    // Build the adapter load status map. Every type that is in the
    // plugin store — loaded OR failed — is surfaced here. Built-ins that
    // were never overridden are omitted (they always work). The map also
    // doubles as the unhealthy signal: any required plugin with a recorded
    // failure flips the response status to 503 so operators (and the
    // OpenClaw monitor) can detect "I shipped a plugin, did it load?"
    // without grepping the boot log.
    const failedLoads = getFailedAdapterLoads();
    const adapters: Record<string, { status: "loaded" | "failed"; error?: string; packageName?: string; timestamp?: string }> = {};
    for (const failure of failedLoads) {
      adapters[failure.type] = {
        status: "failed",
        error: failure.error,
        packageName: failure.packageName,
        timestamp: failure.timestamp,
      };
    }
    const adapterLoadStatus = {
      failed: failedLoads.length,
      ...(Object.keys(adapters).length ? { entries: adapters } : {}),
    };
    const anyAdapterFailed = failedLoads.length > 0;

    if (anyAdapterFailed) {
      // Required plugin load failure flips the response to 503 so a monitor
      // or operator sees the failure without grepping logs. Only required
      // plugins end up in `failedLoads` (optional ones fall through silently
      // by design). Database stays healthy — only the adapter plugin path
      // is broken.
      res.status(503).json({
        status: "unhealthy",
        version: serverVersion,
        serverVersion,
        deploymentMode: opts.deploymentMode,
        deploymentExposure: opts.deploymentExposure,
        bootstrapStatus,
        bootstrapInviteActive,
        error: "adapter_plugin_load_failed",
        adapters: adapterLoadStatus,
        ...(exposeFullDetails ? { serverInfo } : {}),
      });
      return;
    }

    if (!exposeFullDetails) {
      const redactedDatabaseBackup = databaseBackup ? redactedDatabaseBackupHealth(databaseBackup) : undefined;
      const redactedWarnings = redactedDatabaseBackup?.warnings.length ? redactedDatabaseBackup.warnings : undefined;
      res.json({
        status: "ok",
        deploymentMode: opts.deploymentMode,
        deploymentExposure: opts.deploymentExposure,
        bootstrapStatus,
        bootstrapInviteActive,
        ...(adapterLoadStatus.failed > 0 ? { adapters: adapterLoadStatus } : {}),
        ...(redactedDatabaseBackup ? { databaseBackup: redactedDatabaseBackup } : {}),
        ...(redactedWarnings ? { warnings: redactedWarnings } : {}),
        ...(devServer ? { devServer } : {}),
      });
      return;
    }

    res.json({
      status: "ok",
      version: serverVersion,
      serverVersion,
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      bootstrapInviteActive,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
      ...(adapterLoadStatus.failed > 0 ? { adapters: adapterLoadStatus } : {}),
      serverInfo,
      ...(databaseBackup ? { databaseBackup } : {}),
      ...(warnings ? { warnings } : {}),
      ...(devServer ? { devServer } : {}),
    });
  });

  return router;
}
