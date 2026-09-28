/**
 * The facts that a recording proxy between the dashboard and the backend keeps of one native RPC,
 * spelled as the HTTP route that the RPC replaced.
 *
 * A journey ledger compares its requests with the command receipts of the backend, whose normalized
 * targets are the old HTTP routes, so a recorder classifies each RPC by that route: its method and
 * path, the idempotency key and entity tag that its payload carries, and the answer that ends it.
 * Every RPC travels as `POST /api/rpc`; its outcome keeps the status that the problem registry
 * gives a declared problem, and 200 for a success.
 */
import { Array as Arr, Match, Option, Predicate, Schema } from "effect";

type Route = readonly [method: "GET" | "POST", path: string];

const encodePathIdentity = (identity: Schema.Json | undefined): string =>
  encodeURIComponent(Predicate.isString(identity) ? identity : "").replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const interviewRoute = (suffix: string) => (payload: Payload) =>
  `/api/recruitment/interviews/${encodePathIdentity(payload.interviewId)}${suffix}`;

type Payload = Readonly<Record<string, Schema.Json>>;

/** The HTTP route of each RPC that the recruitment, onboarding, and session journeys send. */
const replacedRoutes: ReadonlyMap<string, (payload: Payload) => Route> = new Map<
  string,
  (payload: Payload) => Route
>([
  ["system.readSession", () => ["GET", "/api/session"]],
  ["profile.readOwnProfile", () => ["GET", "/api/profile"]],
  ["recruitment.readInvitationResponse", () => ["GET", "/api/recruitment/invitation-response"]],
  [
    "recruitment.confirmInvitation",
    () => ["POST", "/api/recruitment/invitation-response:confirm"],
  ],
  ["recruitment.rejectInvitation", () => ["POST", "/api/recruitment/invitation-response:reject"]],
  [
    "recruitment.requestNewInvitationTime",
    () => ["POST", "/api/recruitment/invitation-response:request-new-time"],
  ],
  [
    "recruitment.readAssignmentBoard",
    () => ["GET", "/api/recruitment/application-assignments"],
  ],
  ["recruitment.readSchedulingBoard", () => ["GET", "/api/recruitment/interviews"]],
  ["recruitment.readInterviewReport", () => ["GET", "/api/recruitment/interview-report"]],
  [
    "recruitment.createApplicationInterview",
    (payload) => [
      "POST",
      `/api/recruitment/applications/${encodePathIdentity(payload.applicationId)}/interviews`,
    ],
  ],
  ["recruitment.scheduleInterview", (payload) => ["POST", interviewRoute(":schedule")(payload)]],
  ["recruitment.readInterviewConduct", (payload) => ["GET", interviewRoute("")(payload)]],
  ["recruitment.finalizeInterview", (payload) => ["POST", interviewRoute(":finalize")(payload)]],
  [
    "recruitment.correctInterviewAssessment",
    (payload) => ["POST", interviewRoute(":correct")(payload)],
  ],
  ["recruitment.cancelInterview", (payload) => ["POST", interviewRoute(":cancel")(payload)]],
  ["recruitment.readQuestionnaires", () => ["GET", "/api/recruitment/questionnaires"]],
  ["recruitment.readInterviewStaffing", () => ["GET", "/api/recruitment/interview-staffing"]],
  [
    "recruitment.maintainRecruitment",
    () => ["POST", "/api/recruitment/maintenance/commands"],
  ],
  ["onboarding.readBoard", () => ["GET", "/api/onboarding"]],
  ["onboarding.command", () => ["POST", "/api/onboarding"]],
  ["onboarding.claim", () => ["POST", "/api/onboarding/claim"]],
]);

const RpcRequestMessage = Schema.Struct({
  tag: Schema.String,
  payload: Schema.Json,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});

const PayloadRecord = Schema.Record(Schema.String, Schema.Json);

/** One RPC request, as the HTTP route that it replaced. */
export interface ReplacedRequest {
  readonly tag: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly idempotencyKey: string | null;
  readonly ifMatch: string | null;
  /** The command body that the HTTP route took, without the RPC's key, tag, and capability. */
  readonly requestJson: Schema.Json | undefined;
  /** Whether the payload carried an invitation capability, as the old dedicated header did. */
  readonly capabilityPresent: boolean;
  /** The invitation capability of the payload, for a recorder that resolves its holder. */
  readonly capability: string | null;
  /**
   * The headers that the RPC message carries: a server forwards the person's cookie there, where
   * the HTTP request of a browser carries it as a header.
   */
  readonly messageHeaders: Readonly<Record<string, string>>;
  /** The payload members, for a recorder that spells a query the route took. */
  readonly payload: Payload;
}

/**
 * The replaced route of the RPC request that a proxied body carries to the RPC endpoint, or
 * `undefined` for a body that is no RPC request message.
 */
export const replacedRequest = (requestJson: Schema.Json | undefined): ReplacedRequest | undefined =>
  Option.getOrUndefined(
    Option.map(Schema.decodeUnknownOption(RpcRequestMessage)(requestJson), ({ tag, payload, headers }) => {
      const members = Option.getOrElse(
        Schema.decodeUnknownOption(PayloadRecord)(payload),
        (): Payload => ({}),
      );

      const [method, path] = replacedRoutes.get(tag)?.(members) ?? ["POST", "/api/rpc"];

      return {
        tag,
        method,
        path,
        idempotencyKey: Predicate.isString(members.idempotencyKey) ? members.idempotencyKey : null,
        ifMatch: Predicate.isString(members.ifMatch) ? members.ifMatch : null,
        requestJson: "request" in members ? members.request : undefined,
        capabilityPresent: "capability" in members,
        capability: Predicate.isString(members.capability) ? members.capability : null,
        payload: members,
        messageHeaders: Object.fromEntries(
          headers.map(([name, value]) => [name.toLowerCase(), value] as const),
        ),
      };
    }),
  );

const RpcAnswer = Schema.Tuple([
  Schema.Struct({
    exit: Schema.Union([
      Schema.TaggedStruct("Success", { value: Schema.Json }),
      Schema.TaggedStruct("Failure", { cause: Schema.Array(Schema.Json) }),
    ]),
  }),
]);

/** The reason of a failure that carries a declared problem; a defect carries none. */
const FailReason = Schema.Struct({ error: Schema.Json });

const isFailReason = Schema.is(FailReason);

const ProblemStatus = Schema.Struct({ status: Schema.Int });

const TaggedResource = Schema.Union([
  Schema.Struct({ result: Schema.Json, etag: Schema.String }),
  Schema.Struct({ interview: Schema.Json, etag: Schema.String }),
  Schema.Struct({ detail: Schema.Json, etag: Schema.String }),
  Schema.Struct({ observation: Schema.Json, etag: Schema.String }),
  Schema.Struct({ profile: Schema.Json, etag: Schema.String }),
  Schema.Struct({ etag: Schema.String }),
]);

/** The answer that ends one RPC, as the HTTP response of the route that it replaced. */
export interface ReplacedAnswer {
  readonly status: number;
  /** The representation that the HTTP body carried: the resource beside a tag is unwrapped. */
  readonly responseJson: Schema.Json;
  /** The entity tag that the HTTP `ETag` header carried beside the resource, if any. */
  readonly responseEtag: string | null;
}

const unwrapTagged = (value: Schema.Json): ReplacedAnswer =>
  // Exact members: a resource that carries its tag among its own fields stays whole.
  Option.match(Schema.decodeUnknownOption(TaggedResource)(value, { onExcessProperty: "error" }), {
    onNone: () => ({ status: 200, responseJson: value, responseEtag: null }),
    onSome: (tagged) => ({
      status: 200,
      responseJson:
        "result" in tagged
          ? tagged.result
          : "interview" in tagged
            ? tagged.interview
            : "detail" in tagged
              ? tagged.detail
              : "observation" in tagged
                ? tagged.observation
                : "profile" in tagged
                  ? tagged.profile
                  : null,
      responseEtag: tagged.etag,
    }),
  });

/**
 * The answer of the RPC response that a proxied body carries: a success answers its value at 200,
 * a failure answers its problem at the registry status of the problem's code, and a defect, such as
 * a payload that the server refused before the handler, answers 500 with the cause as its body.
 * `undefined` for a body that is no RPC response.
 */
export const replacedAnswer = (responseJson: Schema.Json | undefined): ReplacedAnswer | undefined =>
  Option.match(Schema.decodeUnknownOption(RpcAnswer)(responseJson), {
    onNone: () => undefined,
    onSome: ([{ exit }]) =>
      Match.value(exit).pipe(
        Match.tag("Success", ({ value }) => unwrapTagged(value)),
        Match.tag("Failure", ({ cause }) =>
          Option.match(Arr.findFirst(cause, isFailReason), {
            onNone: () => ({ status: 500, responseJson: cause, responseEtag: null }),
            onSome: ({ error }) => ({
              status: Option.match(Schema.decodeUnknownOption(ProblemStatus)(error), {
                onNone: () => 500,
                onSome: ({ status }) => status,
              }),
              responseJson: error,
              responseEtag: null,
            }),
          }),
        ),
        Match.exhaustive,
      ),
  });

const JsonText = Schema.fromJsonString(Schema.Json);

const parseJsonText = (text: string): Schema.Json | undefined =>
  Option.getOrUndefined(Schema.decodeOption(JsonText)(text));

/**
 * The HTTP response that the route an RPC replaced would have answered, from the RPC's own
 * response: the replaced status, the representation as the body, and the entity tag as the `ETag`
 * header. A probe written against the HTTP contract keeps reading `status`, `headers`, and the
 * body. A response that carries no RPC answer, such as a transport rejection, passes unchanged.
 */
export const replacedHttpResponse = async (response: Response): Promise<Response> => {
  const text = await response.text();
  const answer = replacedAnswer(parseJsonText(text));

  if (answer === undefined) return new Response(text, { status: response.status });

  return new Response(Schema.encodeSync(JsonText)(answer.responseJson), {
    status: answer.status,
    headers:
      answer.responseEtag === null
        ? { "content-type": "application/json" }
        : { "content-type": "application/json", etag: answer.responseEtag },
  });
};

/** The HTTP headers a browser sends with an RPC: the dashboard origin, and its cookie if any. */
export interface BrowserHeaders {
  readonly origin: string;
  readonly cookie?: string | null | undefined;
}

const browserHeaders = (input: BrowserHeaders): Headers => {
  const headers = new Headers({ origin: input.origin, "content-type": "application/json" });

  if (Predicate.isString(input.cookie) && input.cookie.length > 0) {
    headers.set("cookie", input.cookie);
  }

  return headers;
};

/** One RPC request message with a hand-built payload, as the RPC client serializes it. */
const RpcRequest = Schema.TaggedStruct("Request", {
  id: Schema.String,
  tag: Schema.String,
  payload: Schema.Json,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});

const RpcRequestBody = Schema.fromJsonString(RpcRequest);

/**
 * Posts one RPC to the backend at `origin` as a browser would, with `headers` such as the cookie
 * and the dashboard origin, and answers the HTTP response of the route that it replaced. The
 * payload is hand built, so a value that its schema refuses reaches the server, which answers a
 * defect (500).
 */
export const replacedFetch = async (input: {
  readonly origin: string;
  readonly tag: string;
  readonly payload: Schema.Json;
  readonly headers: BrowserHeaders;
}): Promise<Response> =>
  replacedHttpResponse(
    await fetch(new URL("/api/rpc", input.origin), {
      method: "POST",
      headers: browserHeaders(input.headers),
      body: Schema.encodeSync(RpcRequestBody)(
        RpcRequest.make({ id: "0", tag: input.tag, payload: input.payload, headers: [] }),
      ),
    }),
  );
