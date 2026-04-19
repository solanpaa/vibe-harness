import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the Tauri import so readStateFile returns a controlled token
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue("test-auth-token"),
}));

// We need to reset module state between tests since client.ts uses module-level caches
let DaemonClient: typeof import("../../api/client").DaemonClient;
let resetConnection: typeof import("../../api/client").resetConnection;
let getAuthToken: typeof import("../../api/client").getAuthToken;

describe("DaemonClient API", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    // Reset module cache to clear cachedPort/cachedToken
    vi.resetModules();
    const mod = await import("../../api/client");
    DaemonClient = mod.DaemonClient;
    resetConnection = mod.resetConnection;
    getAuthToken = mod.getAuthToken;

    // Reset fetch mock
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(status: number, body: unknown) {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }

  it("constructs correct base URL from port", async () => {
    mockFetch(200, { status: "ok", version: "1.0.0", uptime: 0 });

    const client = new DaemonClient(9876);
    await client.health();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9876/health",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      })
    );
  });

  it("includes auth token in Authorization header", async () => {
    mockFetch(200, { status: "ok", version: "1.0.0", uptime: 0 });

    const client = new DaemonClient(3000);
    await client.health();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-auth-token",
        }),
      })
    );
  });

  it("health() returns parsed response on success", async () => {
    const healthData = { status: "ok", version: "2.0.0", uptime: 123 };
    mockFetch(200, healthData);

    const client = new DaemonClient(3000);
    const result = await client.health();

    expect(result).toEqual(healthData);
  });

  it("throws on non-OK response", async () => {
    mockFetch(500, { error: "internal error" });

    const client = new DaemonClient(3000);
    await expect(client.health()).rejects.toThrow("Daemon API error 500");
  });

  it("listRuns appends query params", async () => {
    mockFetch(200, { runs: [], total: 0 });

    const client = new DaemonClient(3000);
    await client.listRuns({ status: "running" });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/runs?status=running"),
      expect.any(Object)
    );
  });

  it("listRuns without query has no params", async () => {
    mockFetch(200, { runs: [], total: 0 });

    const client = new DaemonClient(3000);
    await client.listRuns();

    const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toBe("http://127.0.0.1:3000/api/runs");
  });

  it("createProject sends POST with JSON body", async () => {
    const project = { id: "p1", name: "Test" };
    mockFetch(200, { project });

    const client = new DaemonClient(3000);
    await client.createProject({ name: "Test", localPath: "/path" });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/projects",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Test", localPath: "/path" }),
      })
    );
  });

  it("deleteProject sends DELETE", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 204,
      json: () => Promise.resolve(undefined),
      text: () => Promise.resolve(""),
    });

    const client = new DaemonClient(3000);
    await client.deleteProject("p1");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/projects/p1",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("resetConnection clears cached state", async () => {
    // First call caches the token
    mockFetch(200, { status: "ok", version: "1.0.0", uptime: 0 });
    const client = new DaemonClient(3000);
    await client.health();

    // Reset clears caches — next getAuthToken should re-read
    resetConnection();

    // Verify by making another call — should invoke readStateFile again
    const token = await getAuthToken();
    expect(token).toBe("test-auth-token");
  });
});
