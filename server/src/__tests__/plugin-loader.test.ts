import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock the store before importing the loader so we control which records
// "exist" without touching the real ~/.paperclip/adapter-plugins.json file.
const mockStore = vi.hoisted(() => ({
  listAdapterPlugins: vi.fn(() => [] as Array<{
    packageName: string;
    localPath?: string;
    type: string;
    installedAt: string;
  }>),
  getAdapterPluginByType: vi.fn(() => undefined),
  getAdapterPluginsDir: vi.fn(() => "/tmp/paperclip-plugin-loader-test"),
}));

vi.mock("../services/adapter-plugin-store.js", () => mockStore);

// Imported AFTER the mock so the loader picks up the mocked store.
const {
  loadExternalAdapterPackage,
  reloadExternalAdapter,
  buildExternalAdapters,
  getFailedAdapterLoads,
  getAdapterLoadStatus,
  clearFailedAdapterLoad,
} = await import("../adapters/plugin-loader.js");

/**
 * Build a tiny package on disk that exports createServerAdapter throwing
 * synchronously — the synthetic PHA-1658 reproducer for "package.json's
 * `main` is broken" without needing real npm dependencies.
 */
function makeBrokenPackageDir(opts: { optional?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-broken-plugin-"));
  const pkg = {
    name: "@paperclip-test/broken",
    version: "0.0.0",
    main: "does-not-exist.js",
    ...(opts.optional ? { paperclip: { optional: true, adapterType: "broken_test" } } : {}),
  };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
}

/** Build a working external adapter module on disk and return its package dir. */
function makeWorkingPackageDir(type = "working_test"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-working-plugin-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "@paperclip-test/working",
      version: "0.0.0",
      main: "index.js",
      paperclip: { adapterType: type },
    }),
  );
  fs.writeFileSync(
    path.join(dir, "index.js"),
    `
      export function createServerAdapter() {
        return {
          type: ${JSON.stringify(type)},
          execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
          testEnvironment: async () => ({
            adapterType: ${JSON.stringify(type)},
            status: "pass",
            checks: [],
            testedAt: new Date(0).toISOString(),
          }),
        };
      }
    `,
  );
  return dir;
}

describe("plugin loader — PHA-1658 surface failures loudly", () => {
  beforeEach(() => {
    // Reset recorded failures between tests so each test starts clean.
    mockStore.listAdapterPlugins.mockReturnValue([]);
    mockStore.getAdapterPluginByType.mockReturnValue(undefined);
  });

  afterEach(() => {
    // Reset module-scoped failure map between tests. Clear each type by
    // calling the public clearFailedAdapterLoad — there is no bulk-clear
    // API, and tests should clean up what they recorded.
    for (const failure of getFailedAdapterLoads()) {
      clearFailedAdapterLoad(failure.type);
    }
  });

  it("records a failure when a required plugin's entry point is missing", async () => {
    const packageDir = makeBrokenPackageDir();
    mockStore.listAdapterPlugins.mockReturnValue([
      { packageName: "@paperclip-test/broken", localPath: packageDir, type: "broken_test", installedAt: "2026-09-01T00:00:00Z" },
    ]);
    mockStore.getAdapterPluginByType.mockImplementation((t: string) =>
      t === "broken_test"
        ? { packageName: "@paperclip-test/broken", localPath: packageDir, type: "broken_test", installedAt: "2026-09-01T00:00:00Z" }
        : undefined,
    );

    const adapters = await buildExternalAdapters();

    // Required plugin fails → loader does NOT throw, the IIFE consumer
    // stays up, but the failure is recorded for health + GET endpoint.
    expect(adapters).toEqual([]);
    expect(getFailedAdapterLoads()).toHaveLength(1);
    const failure = getFailedAdapterLoads()[0];
    expect(failure.type).toBe("broken_test");
    expect(failure.packageName).toBe("@paperclip-test/broken");
    expect(failure.optional).toBe(false);
    expect(failure.error).toMatch(/does-not-exist|Cannot find module|ENOENT/);
    expect(getAdapterLoadStatus("broken_test")).toBe("failed");
  });

  it("does NOT record a failure when an optional plugin fails to load", async () => {
    const packageDir = makeBrokenPackageDir({ optional: true });
    mockStore.listAdapterPlugins.mockReturnValue([
      { packageName: "@paperclip-test/broken", localPath: packageDir, type: "optional_broken", installedAt: "2026-09-01T00:00:00Z" },
    ]);
    mockStore.getAdapterPluginByType.mockImplementation((t: string) =>
      t === "optional_broken"
        ? { packageName: "@paperclip-test/broken", localPath: packageDir, type: "optional_broken", installedAt: "2026-09-01T00:00:00Z" }
        : undefined,
    );

    const adapters = await buildExternalAdapters();

    expect(adapters).toEqual([]);
    expect(getFailedAdapterLoads()).toEqual([]);
    expect(getAdapterLoadStatus("optional_broken")).toBe("not_declared");
  });

  it("clears a recorded failure when the same plugin loads successfully", async () => {
    const brokenDir = makeBrokenPackageDir();
    const workingDir = makeWorkingPackageDir("flap_test");
    mockStore.listAdapterPlugins.mockReturnValue([
      { packageName: "@paperclip-test/broken", localPath: brokenDir, type: "flap_test", installedAt: "2026-09-01T00:00:00Z" },
    ]);
    mockStore.getAdapterPluginByType.mockImplementation((t: string) =>
      t === "flap_test"
        ? { packageName: "@paperclip-test/broken", localPath: brokenDir, type: "flap_test", installedAt: "2026-09-01T00:00:00Z" }
        : undefined,
    );

    await buildExternalAdapters();
    expect(getFailedAdapterLoads()).toHaveLength(1);

    // Operator fixes the broken plugin — entry point now exists.
    fs.writeFileSync(path.join(brokenDir, "does-not-exist.js"), "export function createServerAdapter() { return { type: 'flap_test', execute: async () => ({ exitCode: 0, signal: null, timedOut: false }), testEnvironment: async () => ({ adapterType: 'flap_test', status: 'pass', checks: [], testedAt: new Date(0).toISOString() }) }; }");

    const adapters = await buildExternalAdapters();
    expect(adapters).toHaveLength(1);
    expect(getFailedAdapterLoads()).toEqual([]);
    expect(getAdapterLoadStatus("flap_test")).toBe("not_declared"); // loader clears before consumer sets registry
  });

  it("loadExternalAdapterPackage surfaces a thrown error (does not swallow)", async () => {
    const packageDir = makeBrokenPackageDir();
    await expect(loadExternalAdapterPackage("@paperclip-test/broken", packageDir)).rejects.toThrow(
      /does-not-exist|Cannot find module|ENOENT/,
    );
  });

  it("reloadExternalAdapter throws on broken entry point (does not return null)", async () => {
    const packageDir = makeBrokenPackageDir();
    mockStore.getAdapterPluginByType.mockReturnValue({
      packageName: "@paperclip-test/broken",
      localPath: packageDir,
      type: "broken_test",
      installedAt: "2026-09-01T00:00:00Z",
    });

    // The PHA-1658 contract: reload of a broken plugin throws, the route
    // handler turns that into a structured 5xx (not a 404).
    await expect(reloadExternalAdapter("broken_test")).rejects.toThrow(
      /does-not-exist|Cannot find module|ENOENT/,
    );

    expect(getFailedAdapterLoads()).toHaveLength(1);
    expect(getFailedAdapterLoads()[0].type).toBe("broken_test");
  });

  it("reloadExternalAdapter returns null only when no plugin-store record exists", async () => {
    mockStore.getAdapterPluginByType.mockReturnValue(undefined);
    const result = await reloadExternalAdapter("never_installed");
    expect(result).toBeNull();
    // No record → no failure recorded either.
    expect(getFailedAdapterLoads()).toEqual([]);
  });

  it("reloadExternalAdapter of an optional broken plugin throws but does NOT record", async () => {
    const packageDir = makeBrokenPackageDir({ optional: true });
    mockStore.getAdapterPluginByType.mockReturnValue({
      packageName: "@paperclip-test/broken",
      localPath: packageDir,
      type: "optional_broken",
      installedAt: "2026-09-01T00:00:00Z",
    });

    await expect(reloadExternalAdapter("optional_broken")).rejects.toThrow();
    expect(getFailedAdapterLoads()).toEqual([]);
  });
});
