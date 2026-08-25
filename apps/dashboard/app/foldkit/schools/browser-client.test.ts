import { DepartmentId, SchoolDirectorySchema } from "@vektorprogrammet/sdk/effect";
import { Effect, Fiber, Schema as S } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserSchoolsDirectoryClient } from "./browser-client";
import { SchoolDirectoryData, makeInitialModel, type Model } from "./model";

const directory = {
  activeSchools: [
    {
      schoolId: 1,
      name: "Alfaskolen",
      contactPerson: "Ada Lovelace",
      email: "ada@example.invalid",
      phone: "+47 111 11 111",
      language: "Norwegian",
      departments: [{ departmentId: "department-a", name: "Avdeling A" }],
      isActive: true,
    },
  ],
  inactiveSchools: [],
};

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Schools directory browser client", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends one credentialed native request with optional department narrowing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(directory));

    const result = await Effect.runPromise(
      createBrowserSchoolsDirectoryClient().admin.schools.list({
        department: S.decodeUnknownSync(DepartmentId)("department-a"),
      }),
    );

    expect(result).toEqual(directory);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/schools?department=department-a");
    expect(init?.method).toBe("GET");
    expect(init?.credentials ?? "same-origin").toBe("same-origin");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts the owning runtime's in-flight request without replacing its model", async () => {
    const started = Promise.withResolvers<void>();
    let requestSignal: AbortSignal | undefined;
    let abortObservations = 0;
    fetchMock.mockImplementationOnce((_input, init) => {
      const signal = init?.signal ?? undefined;
      requestSignal = signal;
      started.resolve();
      return new Promise<Response>((_resolve, reject) => {
        if (signal === undefined) {
          reject(new Error("missing abort signal"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            abortObservations += 1;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    });
    const existingModel: Model = {
      ...makeInitialModel(),
      directory: SchoolDirectoryData.Success({
        data: S.decodeUnknownSync(SchoolDirectorySchema)(directory),
      }),
    };
    let renderedModel: Model = existingModel;
    const fiber = Effect.runFork(
      createBrowserSchoolsDirectoryClient()
        .admin.schools.list()
        .pipe(
          Effect.tap((nextDirectory) =>
            Effect.sync(() => {
              renderedModel = {
                ...renderedModel,
                directory: SchoolDirectoryData.Success({ data: nextDirectory }),
              };
            }),
          ),
        ),
    );

    await started.promise;
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal?.aborted).toBe(true);
    expect(abortObservations).toBe(1);
    expect(renderedModel).toBe(existingModel);
  });

  it("strictly rejects excess response fields", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...directory, legacyCapacity: {} }));

    const failure = await Effect.runPromise(
      createBrowserSchoolsDirectoryClient().admin.schools.list().pipe(Effect.flip),
    );

    expect(failure._tag).toBe("SchoolsDecodeError");
  });

  it("preserves a typed Schools rejection returned by the authenticated bridge", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { tag: "AuthorityInactive" } }, 403));

    const failure = await Effect.runPromise(
      createBrowserSchoolsDirectoryClient().admin.schools.list().pipe(Effect.flip),
    );

    expect(failure._tag).toBe("AuthorityInactive");
  });
});
