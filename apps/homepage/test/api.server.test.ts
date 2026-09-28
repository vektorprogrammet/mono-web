import { afterEach, describe, expect, it, vi } from "vitest";
import { callHomepageNative } from "../src/lib/api.server";
import { nativeRpcProblem, stubNativeBackend } from "./native-rpc";

const backend = stubNativeBackend();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("homepage server API origin", () => {
  it("sends each call to the current runtime API_URL, with its own headers only", async () => {
    backend.answer((call) => nativeRpcProblem(call, "credential.missing"));

    const readSession = (headers?: Readonly<Record<string, string>>) =>
      callHomepageNative((client) => client["system.readSession"](), { headers }).catch(
        () => undefined,
      );

    vi.stubEnv("API_URL", "https://api.example.invalid");
    await readSession({ "x-vektor-contact-backend": "one-call-only" });
    vi.stubEnv("API_URL", "https://changed.example.invalid");
    await readSession();

    expect(
      backend.calls.map(({ url, tag, headers }) => [
        url,
        tag,
        headers.get("x-vektor-contact-backend"),
      ]),
    ).toEqual([
      ["https://api.example.invalid/api/rpc/", "system.readSession", "one-call-only"],
      ["https://changed.example.invalid/api/rpc/", "system.readSession", null],
    ]);
  });
});
