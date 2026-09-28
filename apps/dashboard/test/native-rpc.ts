/**
 * A fake native backend for dashboard server tests, at the wire: it reads the RPC request message
 * that `callNative` posts, and answers with the RPC response message that the backend's RPC server
 * writes. A test stubs `fetch` with a function that reads each call and answers it.
 */
import {
  makeNativeValidationError,
  type NativeProblemCode,
  Problem,
  problemBody,
  type ValidationProblemCode,
  SessionResponse,
} from "@vektorprogrammet/rpc";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { Exit, Schema } from "effect";

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

/** One RPC call that the dashboard server sent. */
export interface NativeRpcCall {
  readonly url: string;
  readonly id: typeof RequestId.Type;
  readonly tag: string;
  readonly payload: Schema.Json;
  /** The HTTP headers, with the headers of the RPC message, such as the forwarded cookie, over them. */
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

/** Whether a request addresses the RPC endpoint, rather than Better Auth or another route. */
export const isNativeRpcRequest = (input: Parameters<typeof fetch>[0]): boolean =>
  /^\/api\/rpc\/?$/u.test(
    new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input)
      .pathname,
  );

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

/** The caller's current session, encoded as `system.readSession` answers it. */
export const nativeSession = Schema.encodeSync(Schema.toCodecJson(SessionResponse))(
  SessionResponse.make({
    sessionId: "session-1",
    personId: PersonId.make("person-1"),
    createdAt: "2030-01-01T00:00:00Z",
    updatedAt: "2030-01-01T00:00:00Z",
    expiresAt: "2030-01-02T00:00:00Z",
    ipAddress: null,
    userAgent: null,
    current: true,
  }),
);

/** Answers the session check that `requireAuth` sends with the caller's current session. */
export const nativeSessionAnswer = async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => nativeRpcSuccess(await readNativeRpcCall(input, init), nativeSession);
