import { Effect, Fiber } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserSchoolsDirectoryClient } from "./browser-client";
import { nativeProblemResponse, privateReadHeaders } from "../../../test/native-http";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv("VITE_API_URL", "http://dashboard.test");
  vi.stubGlobal("location", { origin: "http://dashboard.test" });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Schools generated browser client", () => {
  it("aborts the owning runtime's in-flight request", async () => {
    const started = Promise.withResolvers<void>();
    let signal: AbortSignal | null | undefined;
    fetchMock.mockImplementationOnce((input, init) => {
      signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      started.resolve();

      return new Promise<Response>((_resolve, reject) => {
        if (!signal) {
          reject(new Error("missing signal"));

          return;
        }

        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const fiber = Effect.runFork(createBrowserSchoolsDirectoryClient().directory.listSchools());
    await started.promise;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(signal?.aborted).toBe(true);
  });
  it("rejects malformed school facts instead of rendering them", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { activeSchools: [{ schoolId: "invalid" }], inactiveSchools: [] },
        { headers: privateReadHeaders },
      ),
    );

    const failure = await Effect.runPromise(
      createBrowserSchoolsDirectoryClient().directory.listSchools().pipe(Effect.flip),
    );

    expect(failure.error.tag).toBe("SchoolsPersistenceError");
  });
  it("preserves an authority denial from the native API", async () => {
    fetchMock.mockResolvedValueOnce(nativeProblemResponse("authority.denied"));

    const failure = await Effect.runPromise(
      createBrowserSchoolsDirectoryClient().directory.listSchools().pipe(Effect.flip),
    );

    expect(failure.error.tag).toBe("NotInScope");
  });
});
