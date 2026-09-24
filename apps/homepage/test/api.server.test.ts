import { afterEach, describe, expect, it, vi } from "vitest";
import { createHomepageApiClient } from "../src/lib/api.server";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("homepage server API origin", () => {
  it("sends each request to the current runtime API_URL", async () => {
    const urls: string[] = [];

    const fetch: typeof globalThis.fetch = async (input) => {
      urls.push(input instanceof Request ? input.url : String(input));

      return Response.json({ status: "ok" }, {
        headers: { "cache-control": "no-store", vary: "Origin" },
      });
    };

    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("API_URL", "https://origin-api.vektor.phibkro.org");
    await createHomepageApiClient().system.health();
    vi.stubEnv("API_URL", "https://changed.example.invalid");
    await createHomepageApiClient().system.health();
    expect(urls).toEqual([
      "https://origin-api.vektor.phibkro.org/health",
      "https://changed.example.invalid/health",
    ]);
  });
});
