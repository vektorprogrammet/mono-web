/**
 * A fake native backend for homepage server tests, at the wire: it reads the RPC request message
 * that `callHomepageNative` posts, and answers with the RPC response message that the backend's RPC
 * server writes.
 *
 * The RPC client's fetch transport reads `globalThis.fetch` once, on its first request, and keeps
 * it. A test file therefore stubs `fetch` once with `stubNativeBackend`, and each test sets the
 * answer through the function that it returns.
 */
import {
  makeNativeValidationError,
  type NativeProblemCode,
  Problem,
  problemBody,
  type ValidationProblemCode,
} from "@vektorprogrammet/rpc";
import { Exit, Schema } from "effect";
import { vi } from "vitest";

/** The RPC client numbers its requests; the answer echoes the number. */
const RequestId = Schema.Union([Schema.String, Schema.Finite]);

const RpcRequestBody = Schema.fromJsonString(
  Schema.TaggedStruct("Request", {
    id: RequestId,
    tag: Schema.String,
    payload: Schema.Json,
    headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  }),
);

const RpcExitMessage = Schema.TaggedStruct("Exit", {
  requestId: RequestId,
  exit: Schema.Json,
});

/** An exit whose success, failure, and defect are already JSON, as the RPC server encodes them. */
const encodeJsonExit = Schema.encodeSync(
  Schema.toCodecJson(Schema.Exit(Schema.Json, Schema.Json, Schema.Json)),
);

/** One RPC call that the homepage server sent. */
export interface NativeRpcCall {
  readonly url: string;
  readonly id: typeof RequestId.Type;
  readonly tag: string;
  readonly payload: Schema.Json;
  /** The HTTP headers, with the headers of the RPC message, such as the contact secret, over them. */
  readonly headers: Headers;
}

/** Reads the RPC call that `input` posts to the RPC endpoint. */
export async function readNativeRpcCall(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<NativeRpcCall> {
  const request = new Request(input, init);
  const body = Schema.decodeSync(RpcRequestBody)(await request.text());
  const headers = new Headers(request.headers);

  for (const [name, value] of body.headers) headers.set(name, value);

  return { url: request.url, id: body.id, tag: body.tag, payload: body.payload, headers };
}

/** Answers `call` with a success whose value the test encoded with the RPC's success schema. */
export const nativeRpcSuccess = (call: NativeRpcCall, encoded: Schema.Json): Response =>
  Response.json([
    RpcExitMessage.make({ requestId: call.id, exit: encodeJsonExit(Exit.succeed(encoded)) }),
  ]);

const isValidationCode = (code: NativeProblemCode): code is ValidationProblemCode =>
  code === "validation.failed" ||
  code === "validation.no-change" ||
  code === "validation.field-not-deletable";

/**
 * Answers `call` with the declared problem `code`; a validation problem carries one diagnostic at
 * the root pointer, as `requestInvalid` answers.
 */
export const nativeRpcProblem = (call: NativeRpcCall, code: NativeProblemCode): Response => {
  const problem = isValidationCode(code)
    ? Problem.validation(code, [makeNativeValidationError("", "invalid")])
    : Problem.fromWire({ code }, {});

  return Response.json([
    RpcExitMessage.make({
      requestId: call.id,
      exit: encodeJsonExit(Exit.fail({ ...problemBody(problem) })),
    }),
  ]);
};

/** Answers one RPC call; a test replaces it per case. */
export type NativeBackend = (call: NativeRpcCall) => Response | Promise<Response>;

/**
 * Stubs `fetch` with one stable transport that reads each RPC call and passes it to the current
 * backend. Returns the function that sets the backend, and the calls that the transport read.
 */
export const stubNativeBackend = () => {
  const calls: Array<NativeRpcCall> = [];

  let backend: NativeBackend = (call) => {
    throw new Error(`Unexpected native RPC ${call.tag}`);
  };

  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const call = await readNativeRpcCall(input, init);
      calls.push(call);

      return backend(call);
    }),
  );

  return {
    calls,
    answer: (next: NativeBackend) => {
      backend = next;
    },
  };
};
