import { ListSchools } from "@vektorprogrammet/rpc";
import { Problem } from "@vektorprogrammet/rpc/problem";
import { Effect, Exit, Fiber, Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserSchoolsDirectoryClient } from "./browser-client";

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

/** The one RPC request that the browser client sent, as the JSON serialization writes it. */
const RequestId = Schema.Union([Schema.String, Schema.Int]);

const RpcRequestBody = Schema.fromJsonString(Schema.Struct({ id: RequestId }));

/** The answer that ends one RPC request, as the JSON serialization writes it. */
const ExitMessage = Schema.TaggedStruct("Exit", { requestId: RequestId, exit: Schema.Unknown });

/** A success exit whose value the test chooses, the contract notwithstanding. */
const SuccessExit = Schema.TaggedStruct("Success", { value: Schema.Json });

const encodeListSchoolsExit = Schema.encodeSync(Schema.toCodecJson(Rpc.exitSchema(ListSchools)));

type EncodedExit = ReturnType<typeof encodeListSchoolsExit> | typeof SuccessExit.Type;

/** A fetch that answers the RPC it receives with `exit`. */
const rpcAnswer =
  (exit: EncodedExit) =>
  async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const { id } = Schema.decodeSync(RpcRequestBody)(await new Response(init?.body).text());

    return Response.json([ExitMessage.make({ requestId: id, exit })]);
  };

describe("Schools browser RPC client", () => {
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
    fetchMock.mockImplementationOnce(
      rpcAnswer(
        SuccessExit.make({
          value: { activeSchools: [{ schoolId: "invalid" }], inactiveSchools: [] },
        }),
      ),
    );

    const failure = await Effect.runPromise(
      createBrowserSchoolsDirectoryClient().directory.listSchools().pipe(Effect.flip),
    );

    expect(failure.error.tag).toBe("SchoolsPersistenceError");
  });
  it("preserves an authority denial from the native API", async () => {
    fetchMock.mockImplementationOnce(
      rpcAnswer(encodeListSchoolsExit(Exit.fail(Problem.make("authority.denied")))),
    );

    const failure = await Effect.runPromise(
      createBrowserSchoolsDirectoryClient().directory.listSchools().pipe(Effect.flip),
    );

    expect(failure.error.tag).toBe("NotInScope");
  });
});
