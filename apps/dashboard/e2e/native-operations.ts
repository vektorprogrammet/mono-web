/**
 * The native surface that a dashboard-to-backend recorder allows, derived from the RPC contract.
 *
 * Every native operation is an RPC of `NativeRpcs`, sent as `POST /api/rpc`; the health probe
 * stays `GET /health`. A recorder that keeps the request body reads the RPC tag from it, so a
 * request to the RPC endpoint counts as native only when it names an RPC of the contract. Use it to
 * prove that a journey sends no legacy, provider, recovery, or token request, rather than listing
 * such routes by name.
 */
import { NativeProblem, NativeRpcs, nativeRpcPath } from "@vektorprogrammet/rpc";
import { Array as Arr, Match, Option, Predicate, Schema } from "effect";

/** One RPC request message, as the JSON serialization of the RPC client sends it over HTTP. */
const RpcRequestMessage = Schema.fromJsonString(
  Schema.TaggedStruct("Request", { tag: Schema.String }),
);

const decodeRpcRequest = Schema.decodeUnknownOption(RpcRequestMessage);

/** The full request message, as the RPC client sends it with no forwarded headers. */
const RpcRequest = Schema.TaggedStruct("Request", {
  id: Schema.String,
  tag: Schema.String,
  payload: Schema.Json,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});

const encodeRpcRequest = Schema.encodeSync(Schema.fromJsonString(RpcRequest));

/**
 * The body of one RPC request that a probe posts to the RPC endpoint as a browser would, with its
 * cookie and origin as HTTP headers: the ingress then decides the origin before any RPC runs.
 */
export const nativeRpcRequestBody = (tag: string, payload: Schema.Json = null): string =>
  encodeRpcRequest(RpcRequest.make({ id: "0", tag, payload, headers: [] }));

/**
 * The RPC tag that one request body to the RPC endpoint names, such as `system.readSession`, or
 * `undefined` when the body is no RPC request message.
 */
export const nativeRpcTag = (body: string): string | undefined =>
  Option.getOrUndefined(Option.map(decodeRpcRequest(body), (message) => message.tag));

const RequestId = Schema.Union([Schema.String, Schema.Finite]);

/** The terminal message of one RPC response, as the JSON serialization writes it over HTTP. */
const RpcExitMessage = Schema.TaggedStruct("Exit", {
  requestId: RequestId,
  exit: Schema.Union([
    Schema.TaggedStruct("Success", { value: Schema.Json }),
    Schema.TaggedStruct("Failure", { cause: Schema.Array(Schema.Json) }),
  ]),
});

const decodeRpcResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Json)),
);

const isRpcExitMessage = Schema.is(RpcExitMessage);

const FailReason = Schema.TaggedStruct("Fail", { error: NativeProblem });

const isFailReason = Schema.is(FailReason);

/** What one RPC answered: its value, a declared problem, or a defect. */
export const NativeRpcOutcome = Schema.Union([
  Schema.TaggedStruct("Success", { value: Schema.Json }),
  Schema.TaggedStruct("Problem", { status: Schema.Finite, problem: NativeProblem }),
  Schema.TaggedStruct("Defect", {}),
]);

export type NativeRpcOutcome = typeof NativeRpcOutcome.Type;

/**
 * The outcome that one RPC response body carries, or `undefined` when the body is no RPC response.
 * Every RPC answers HTTP 200; a declared problem carries the status that the problem registry gives
 * its code, so a recorder can keep comparing statuses.
 */
export const nativeRpcOutcome = (body: string): NativeRpcOutcome | undefined => {
  const exit = Option.flatMap(decodeRpcResponse(body), Arr.findFirst(isRpcExitMessage));

  if (Option.isNone(exit)) return undefined;

  return Match.value(exit.value.exit).pipe(
    Match.tag("Success", ({ value }) => NativeRpcOutcome.members[0].make({ value })),
    Match.tag("Failure", ({ cause }) =>
      Option.match(Arr.findFirst(cause, isFailReason), {
        onNone: () => NativeRpcOutcome.members[2].make({}),
        onSome: ({ error }) =>
          NativeRpcOutcome.members[1].make({ status: error.status, problem: error }),
      }),
    ),
    Match.exhaustive,
  );
};

/** The success value that one RPC response carries, or `undefined` for any other answer. */
export const nativeRpcValue = (body: string): Schema.Json | undefined => {
  const outcome = nativeRpcOutcome(body);

  return Predicate.isTagged(outcome, "Success") ? outcome.value : undefined;
};

/** The status that one RPC response answered under the HTTP contract: 200, or its problem's. */
export const nativeRpcStatus = (body: string): number | undefined => {
  const outcome = nativeRpcOutcome(body);

  return outcome === undefined
    ? undefined
    : Match.value(outcome).pipe(
        Match.tag("Success", () => 200),
        Match.tag("Problem", ({ status }) => status),
        Match.tag("Defect", () => 500),
        Match.exhaustive,
      );
};

/** The RPC client posts to the endpoint URL, which its HTTP client may end with one slash. */
const isRpcPath = (pathname: string): boolean =>
  pathname === nativeRpcPath || pathname === `${nativeRpcPath}/`;

/**
 * Whether a request is an operation of the native contract: an RPC of `NativeRpcs` at the RPC
 * endpoint, or the health probe. When `body` is given, a request to the RPC endpoint must name an
 * RPC of the contract.
 */
export const isNativeOperation = (method: string, pathname: string, body?: string): boolean => {
  if (method === "GET" && pathname === "/health") return true;

  if (method !== "POST" || !isRpcPath(pathname)) return false;

  if (body === undefined) return true;

  const tag = nativeRpcTag(body);

  return tag !== undefined && NativeRpcs.requests.has(tag);
};

/** The identity engine's email-password routes, which native journeys call beside the contract. */
const identityEngineRequests = {
  "POST /api/auth/sign-in/email": true,
  "POST /api/auth/sign-up/email": true,
  "GET /api/auth/get-session": true,
} satisfies Readonly<Record<string, true>>;

/**
 * Whether a dashboard-to-backend request stays on the native surface: an operation of the
 * native RPC contract or an email-password route of the identity engine.
 *
 * @remarks
 * Every native operation is an RPC of `NativeRpcs`, which the client posts to the RPC endpoint
 * (`POST /api/rpc`, with or without one trailing slash); `GET /health` is the one plain HTTP
 * operation. When the recorder passes the request `body`, a request to the RPC endpoint is native
 * only when the RPC request message in it names an RPC of `NativeRpcs`, so an unknown tag leaves
 * the surface. Beside the contract, only `POST /api/auth/sign-in/email`,
 * `POST /api/auth/sign-up/email`, and `GET /api/auth/get-session` are native. Every other request,
 * such as a legacy API call or a provider, recovery, or token route, leaves the surface. The path
 * is compared whole, so no opaque value in it can match by chance.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * proxy.records.filter(({ method, pathname, body }) => !isNativeRequest(method, pathname, body));
 * ```
 *
 * @avoid A recorder that lists the forbidden routes by name, or tests a path for a substring: a
 * new legacy or provider route passes the list, and an opaque value in a path matches a route
 * name by chance. Ask `isNativeRequest` whether the request stays on the native surface.
 *
 * @construct request-ledger
 */
export const isNativeRequest = (method: string, pathname: string, body?: string): boolean =>
  isNativeOperation(method, pathname, body) ||
  Object.hasOwn(identityEngineRequests, `${method} ${pathname}`);
