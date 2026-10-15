import { describe, expect, it, vi } from "vitest";
import { createBackendAPI } from "./api";

describe("backend API client", () => {
  it("includes the host-only OAuth cookie and never sends an OAuth bearer header", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ authenticated: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const api = createBackendAPI("https://manager.example.test", fetcher);
    await api.session();

    expect(fetcher).toHaveBeenCalledWith("https://manager.example.test/api/session", expect.objectContaining({ credentials: "include" }));
    const request = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).has("Authorization")).toBe(false);
  });
});
