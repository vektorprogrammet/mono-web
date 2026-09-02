import { afterEach, describe, expect, it, vi } from "vitest";

const { createPromiseClient } = vi.hoisted(() => ({
  createPromiseClient: vi.fn((url) => ({ url })),
}));
vi.mock("@vektorprogrammet/sdk", () => ({ createPromiseClient }));

import { createHomepageApiClient } from "../src/lib/api.server";

const originalApiUrl = process.env.API_URL;
afterEach(() => {
  createPromiseClient.mockClear();
  if (originalApiUrl === undefined) delete process.env.API_URL;
  else process.env.API_URL = originalApiUrl;
});

describe("homepage server API origin", () => {
  it("reads API_URL at request runtime", () => {
    process.env.API_URL = "https://origin-api.vektor.phibkro.org";
    createHomepageApiClient();
    expect(createPromiseClient).toHaveBeenLastCalledWith("https://origin-api.vektor.phibkro.org");

    process.env.API_URL = "https://changed.example.invalid";
    createHomepageApiClient();
    expect(createPromiseClient).toHaveBeenLastCalledWith("https://changed.example.invalid");
  });
});
