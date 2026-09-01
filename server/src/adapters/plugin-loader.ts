/**
 * External adapter plugin loader.
 *
 * Loads external adapter packages from the adapter-plugin-store and returns
 * their ServerAdapterModule instances. The caller (registry.ts) is
 * responsible for registering them.
 *
 * This avoids circular initialization: plugin-loader imports only
 * adapter-utils, never registry.ts.
 */

import fs from "node:fs";
import path from "node:path";
import type { ServerAdapterModule } from "./types.js";
import { logger } from "../middleware/logger.js";

import {
  listAdapterPlugins,
  getAdapterPluginsDir,
  getAdapterPluginByType,
} from "../services/adapter-plugin-store.js";
import type { AdapterPluginRecord } from "../services/adapter-plugin-store.js";

// ---------------------------------------------------------------------------
// In-memory UI parser cache
// ---------------------------------------------------------------------------

const uiParserCache = new Map<string, string>();

export function getUiParserSource(adapterType: string): string | undefined {
  return uiParserCache.get(adapterType);
}

/**
 * On cache miss, attempt on-demand extraction from the plugin store.
 * Makes the ui-parser.js endpoint self-healing.
 */
export function getOrExtractUiParserSource(adapterType: string): string | undefined {
  const cached = uiParserCache.get(adapterType);
  if (cached) return cached;

  const record = getAdapterPluginByType(adapterType);
  if (!record) return undefined;

  const packageDir = resolvePackageDir(record);
  const source = extractUiParserSource(packageDir, record.packageName);
  if (source) {
    uiParserCache.set(adapterType, source);
    logger.info(
      { type: adapterType, packageName: record.packageName, origin: "lazy" },
      "UI parser extracted on-demand (cache miss)",
    );
  }
  return source;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolvePackageDir(record: Pick<AdapterPluginRecord, "localPath" | "packageName">): string {
  return record.localPath
    ? path.resolve(record.localPath)
    : path.resolve(getAdapterPluginsDir(), "node_modules", record.packageName);
}

function resolvePackageEntryPoint(packageDir: string): string {
  const pkgJsonPath = path.join(packageDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));

  if (pkg.exports && typeof pkg.exports === "object" && pkg.exports["."]) {
    const exp = pkg.exports["."];
    return typeof exp === "string" ? exp : (exp.import ?? exp.default ?? "index.js");
  }
  return pkg.main ?? "index.js";
}

// ---------------------------------------------------------------------------
// UI parser extraction
// ---------------------------------------------------------------------------

const SUPPORTED_PARSER_CONTRACT = "1";

function extractUiParserSource(
  packageDir: string,
  packageName: string,
): string | undefined {
  const pkgJsonPath = path.join(packageDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));

  if (!pkg.exports || typeof pkg.exports !== "object" || !pkg.exports["./ui-parser"]) {
    return undefined;
  }

  const contractVersion = pkg.paperclip?.adapterUiParser;
  if (contractVersion) {
    const major = contractVersion.split(".")[0];
    if (major !== SUPPORTED_PARSER_CONTRACT) {
      logger.warn(
        { packageName, contractVersion, supported: `${SUPPORTED_PARSER_CONTRACT}.x` },
        "Adapter declares unsupported UI parser contract version — skipping UI parser",
      );
      return undefined;
    }
  } else {
    logger.info(
      { packageName },
      "Adapter has ./ui-parser export but no paperclip.adapterUiParser version — loading anyway (future versions may require it)",
    );
  }

  const uiParserExp = pkg.exports["./ui-parser"];
  const uiParserFile = typeof uiParserExp === "string"
    ? uiParserExp
    : (uiParserExp.import ?? uiParserExp.default);
  const uiParserPath = path.resolve(packageDir, uiParserFile);

  if (!uiParserPath.startsWith(packageDir + path.sep) && uiParserPath !== packageDir) {
    logger.warn(
      { packageName, uiParserFile },
      "UI parser path escapes package directory — skipping",
    );
    return undefined;
  }

  if (!fs.existsSync(uiParserPath)) {
    return undefined;
  }

  try {
    const source = fs.readFileSync(uiParserPath, "utf-8");
    logger.info(
      { packageName, uiParserFile, size: source.length },
      `Loaded UI parser from adapter package${contractVersion ? "" : " (no version declared)"}`,
    );
    return source;
  } catch (err) {
    logger.warn({ err, packageName, uiParserFile }, "Failed to read UI parser from adapter package");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Load outcome tracking
// ---------------------------------------------------------------------------

export type AdapterLoadStatus = "loaded" | "failed" | "not_declared";

export interface AdapterLoadFailure {
  type: string;
  packageName: string;
  packageDir: string;
  error: string;
  /** True if the plugin was declared `optional: true` in its package.json. */
  optional: boolean;
  timestamp: string;
}

/**
 * Module-scoped record of every plugin that failed to load at boot or via
 * runtime reload. The registry reads this list to populate the health
 * endpoint and the GET /api/adapters/:type status field. Cleared by a
 * successful reload of the same type.
 */
const failedLoads = new Map<string, AdapterLoadFailure>();

/**
 * Whether the next external plugin to fail should be treated as required
 * (boot-time must surface the failure) or optional (silently fall through
 * to the built-in). Set from `package.json.paperclip.optional` at load time.
 */
function isOptionalPlugin(packageDir: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(packageDir, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    return pkg.paperclip?.optional === true;
  } catch {
    return false;
  }
}

/** Public read of the failure list. Read-only by reference — never mutate. */
export function getFailedAdapterLoads(): AdapterLoadFailure[] {
  return Array.from(failedLoads.values());
}

/** Clear a recorded failure once the same type has loaded successfully. */
export function clearFailedAdapterLoad(type: string): void {
  failedLoads.delete(type);
}

export function getAdapterLoadStatus(type: string): AdapterLoadStatus {
  if (failedLoads.has(type)) return "failed";
  // The actual `loaded` distinction is owned by registry.ts (which has the
  // adaptersByType map). The caller should consult findServerAdapter(type)
  // and combine with this status to render "loaded" vs "not_declared".
  return "not_declared";
}

// ---------------------------------------------------------------------------
// Load / reload
// ---------------------------------------------------------------------------

function validateAdapterModule(mod: unknown, packageName: string): ServerAdapterModule {
  const m = mod as Record<string, unknown>;
  const createServerAdapter = m.createServerAdapter;
  if (typeof createServerAdapter !== "function") {
    throw new Error(
      `Package "${packageName}" does not export createServerAdapter(). ` +
      `Ensure the package's main entry exports a createServerAdapter function.`,
    );
  }

  const adapterModule = createServerAdapter() as ServerAdapterModule;
  if (!adapterModule || !adapterModule.type) {
    throw new Error(
      `createServerAdapter() from "${packageName}" returned an invalid module (missing "type").`,
    );
  }
  return adapterModule;
}

export async function loadExternalAdapterPackage(
  packageName: string,
  localPath?: string,
): Promise<ServerAdapterModule> {
  const packageDir = localPath
    ? path.resolve(localPath)
    : path.resolve(getAdapterPluginsDir(), "node_modules", packageName);

  const entryPoint = resolvePackageEntryPoint(packageDir);
  const modulePath = path.resolve(packageDir, entryPoint);
  const uiParserSource = extractUiParserSource(packageDir, packageName);

  logger.info({ packageName, packageDir, entryPoint, modulePath, hasUiParser: !!uiParserSource }, "Loading external adapter package");

  const mod = await import(modulePath);
  const adapterModule = validateAdapterModule(mod, packageName);

  if (uiParserSource) {
    uiParserCache.set(adapterModule.type, uiParserSource);
  }

  return adapterModule;
}

/**
 * Load a single external adapter from its plugin-store record.
 *
 * Returns the loaded module on success. On failure, records the error in the
 * module-scoped `failedLoads` map (read by getFailedAdapterLoads) so the
 * health endpoint, GET /api/adapters/:type, and the operator can see that
 * the plugin is broken — instead of silently falling through to the built-in.
 *
 * An `optional: true` plugin (declared in its package.json under the
 * `paperclip` key) is allowed to fail without recording a load failure: the
 * goal is "this is a best-effort enhancement, the built-in is fine."
 *
 * A *required* plugin (the default) still returns null on failure so the
 * IIFE consumer does not throw — but the failure IS recorded. The server
 * stays up (so DB-backed work survives), but the operator gets a loud signal
 * via /api/health, /api/adapters/:type, and the boot log.
 */
async function loadFromRecord(record: AdapterPluginRecord): Promise<ServerAdapterModule | null> {
  const packageDir = resolvePackageDir(record);
  const optional = isOptionalPlugin(packageDir);

  try {
    const adapter = await loadExternalAdapterPackage(record.packageName, record.localPath);
    clearFailedAdapterLoad(record.type);
    return adapter;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (optional) {
      logger.warn(
        { err, packageName: record.packageName, type: record.type, optional: true },
        "Optional external adapter failed to load — built-in will serve traffic",
      );
      // Do NOT record this as a load failure; the operator marked it best-effort.
      return null;
    }

    logger.error(
      { err, packageName: record.packageName, type: record.type, packageDir },
      `External adapter "${record.packageName}" FAILED to load: ${message}`,
    );
    failedLoads.set(record.type, {
      type: record.type,
      packageName: record.packageName,
      packageDir,
      error: message,
      optional: false,
      timestamp: new Date().toISOString(),
    });
    // Return null so the IIFE does not throw, but the failure is recorded.
    return null;
  }
}

/**
 * Reload an external adapter at runtime (dev iteration without server restart).
 * Busts the ESM module cache via a cache-busting query string.
 *
 * Throws (does NOT return null) on actual load failure when the record exists
 * but the package.json entry point is broken or the module throws on import.
 * This is the post-boot counterpart to buildExternalAdapters: an agent that
 * calls POST /api/adapters/:type/reload needs to know *why* it failed, not
 * just "the adapter is still missing."
 *
 * Returns null only when the type has no plugin-store record at all (the
 * caller, the reload route, maps that to a 404 — "not an external adapter").
 */
export async function reloadExternalAdapter(
  type: string,
): Promise<ServerAdapterModule | null> {
  const record = getAdapterPluginByType(type);
  if (!record) return null;

  const packageDir = resolvePackageDir(record);
  const entryPoint = resolvePackageEntryPoint(packageDir);
  const modulePath = path.resolve(packageDir, entryPoint);
  const fileUrl = `file://${modulePath}`;

  // Bust ESM module cache so re-import loads fresh code from disk.
  // Query-string trick (?t=...) works in Node; Bun may need the file:// URL
  // to be evicted from its internal registry first.
  try {
    // @ts-expect-error -- Bun internal module cache
    const bunCache = globalThis.Bun?.__moduleCache as Map<string, unknown> | undefined;
    if (bunCache) {
      bunCache.delete(fileUrl);
      bunCache.delete(modulePath);
    }
  } catch {
    // Ignore — query-string fallback still works in Node
  }

  const cacheBustUrl = `${fileUrl}?t=${Date.now()}`;

  logger.info(
    { type, packageName: record.packageName, modulePath, cacheBustUrl },
    "Reloading external adapter (cache bust)",
  );

  let adapterModule: ServerAdapterModule;
  try {
    const mod = await import(cacheBustUrl);
    adapterModule = validateAdapterModule(mod, record.packageName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const optional = isOptionalPlugin(packageDir);
    logger.error(
      { err, type, packageName: record.packageName, modulePath },
      `External adapter "${record.packageName}" FAILED to reload: ${message}`,
    );
    if (!optional) {
      failedLoads.set(type, {
        type,
        packageName: record.packageName,
        packageDir,
        error: message,
        optional: false,
        timestamp: new Date().toISOString(),
      });
    }
    // Re-throw so the caller (route handler) returns a structured 5xx body
    // instead of a silent 404. The previous behavior returned null on any
    // failure, which conflated "no such record" with "the record exists but
    // is broken" — exactly the silent-skip mode PHA-1658 was filed against.
    throw err;
  }

  uiParserCache.delete(type);
  const uiParserSource = extractUiParserSource(packageDir, record.packageName);
  if (uiParserSource) {
    uiParserCache.set(adapterModule.type, uiParserSource);
  }

  // Successful reload — clear any prior failure record for this type.
  clearFailedAdapterLoad(type);

  logger.info(
    { type, packageName: record.packageName, hasUiParser: !!uiParserSource },
    "Successfully reloaded external adapter",
  );

  return adapterModule;
}

/**
 * Build all external adapter modules from the plugin store.
 */
export async function buildExternalAdapters(): Promise<ServerAdapterModule[]> {
  const results: ServerAdapterModule[] = [];

  const storeRecords = listAdapterPlugins();
  for (const record of storeRecords) {
    const adapter = await loadFromRecord(record);
    if (adapter) {
      results.push(adapter);
    }
  }

  if (results.length > 0) {
    logger.info(
      { count: results.length, adapters: results.map((a) => a.type) },
      "Loaded external adapters from plugin store",
    );
  }

  return results;
}
