import { RecruitmentInvitationCapabilitySchema,
RecruitmentInvitationResponseMessageSchema, } from "@vektorprogrammet/http-api"
import { parseJsonWithUniqueMembers } from "@vektorprogrammet/http-api"
import { createConfiguredPromiseClient } from "@vektorprogrammet/sdk";
import { Schema as S, Match, flow, Option } from "effect";
import { nativeProblemFrom } from "./native-problem";
import { InvitationBridgeFailureSchema, decodeInvitationInteractionId, INVITATION_INTERACTION_HEADER, type InvitationBridgeFailure, type InvitationBridgeOperation, type InvitationInteractionId, InvitationBridgeOperationSchema } from "../foldkit/interview/bridge";

export const InvitationCapabilityCookiePrefix = "recruitment_invitation_capability_";

const MaximumBridgeBodyBytes = 16_384;

const SecureCookieAttribute = process.env.NODE_ENV === "production" ? "; Secure" : "";

const isInvitationResponseMessage = S.is(RecruitmentInvitationResponseMessageSchema);

const invalidInvitationRequest = (): InvitationBridgeFailure => (InvitationBridgeFailureSchema.cases.InvitationDecodeError.make({message: "Invalid invitation response request"}));

const readBoundedRequestBody = async (request: Request): Promise<Uint8Array> => {
  const declaredLength = request.headers.get("content-length");

  const expectedLength =
    declaredLength === null || !/^\d+$/u.test(declaredLength) ? null : Number(declaredLength);

  if (
    (declaredLength !== null && expectedLength === null) ||
    expectedLength === 0 ||
    (expectedLength !== null && expectedLength > MaximumBridgeBodyBytes) ||
    request.body === null
  ) {
    throw invalidInvitationRequest();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) break;
      byteLength += chunk.value.byteLength;

      if (byteLength > MaximumBridgeBodyBytes) {
        await reader.cancel().catch(() => undefined);
        throw invalidInvitationRequest();
      }

      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  if (byteLength === 0 || (expectedLength !== null && byteLength !== expectedLength)) {
    throw invalidInvitationRequest();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
};

export const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

export const ownerEnabled = (): boolean => process.env.DASHBOARD_INTERVIEW_OWNER === "foldkit";

const invitationInteractionId = (request: Request): InvitationInteractionId => {
  try {
    return decodeInvitationInteractionId(request.headers.get(INVITATION_INTERACTION_HEADER));
  } catch {
    throw InvitationBridgeFailureSchema.cases.InvitationDecodeError.make({message: "Invalid invitation interaction binding"}) satisfies InvitationBridgeFailure;
  }
};

const invitationCapability = (
  request: Request,
): typeof RecruitmentInvitationCapabilitySchema.Type => {
  const cookieName = `${InvitationCapabilityCookiePrefix}${invitationInteractionId(request)}`;
  const cookiePrefix = `${cookieName}=`;

  const encodedValues = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.startsWith(cookiePrefix))
    .map((cookie) => cookie.slice(cookiePrefix.length));

  if (encodedValues.length !== 1) {
    throw InvitationBridgeFailureSchema.cases.InvitationNotFound.make({message: "Invitation capability unavailable"}) satisfies InvitationBridgeFailure;
  }

  try {
    return S.decodeSync(RecruitmentInvitationCapabilitySchema)(
      decodeURIComponent(encodedValues[0] ?? ""),
    );
  } catch {
    throw InvitationBridgeFailureSchema.cases.InvitationNotFound.make({message: "Invitation capability unavailable"}) satisfies InvitationBridgeFailure;
  }
};

const decodeExchangeCapability = S.decodeUnknownSync(RecruitmentInvitationCapabilitySchema, {onExcessProperty: "error"});

export const createInvitationInteractionId = (): InvitationInteractionId => {
  const randomBytes = crypto.getRandomValues(new Uint8Array(16));
  let interactionId = "";

  for (const byte of randomBytes) interactionId += byte.toString(16).padStart(2, "0");

  return decodeInvitationInteractionId(interactionId);
};

export const createInvitationCapabilityCookie = (
  interactionId: InvitationInteractionId,
  capability: string,
  bridgePath: string,
): string => {
  const cookieName = `${InvitationCapabilityCookiePrefix}${decodeInvitationInteractionId(
    interactionId,
  )}`;

  const decodedCapability = decodeExchangeCapability(capability);

  if (bridgePath !== "/interview" && bridgePath !== "/dashboard/interview") {
    throw new Error("Invitation bridge path must match a supported dashboard mount");
  }

  return `${cookieName}=${encodeURIComponent(decodedCapability)}; Path=${bridgePath}; HttpOnly; SameSite=Strict${SecureCookieAttribute}`;
};

const createInvitationClient = (capability: typeof RecruitmentInvitationCapabilitySchema.Type) =>
  createConfiguredPromiseClient({
    headers: { "X-Recruitment-Invitation-Capability": capability },
  }).recruitment;

export const readInvitationCapability = async (capability: string) => {
  const client = createInvitationClient(decodeExchangeCapability(capability));
  const result = await client.readInvitationResponse({ headers: {} });

  if (result.body === undefined) throw new Error("Invitation response did not include a body");

  return result.body;
};

export const decodeOperation = flow(
  S.decodeUnknownOption(InvitationBridgeOperationSchema, {onExcessProperty: "error"}),
  Option.getOrElse(() => {throw InvitationBridgeFailureSchema.cases.InvitationDecodeError.make({message: "Invalid invitation response operation"});}),
  (operation): InvitationBridgeOperation => {
    if(operation.operation !== "rejectInvitation") return operation;
    const message = operation.message?.trim() ?? null;

    if(message !== null && message !== "" && !isInvitationResponseMessage(message)) throw InvitationBridgeFailureSchema.cases.InvitationDecodeError.make({message:"Invalid invitation response operation"});

    return {...operation, message: message === "" ? null : message};
  },
);

export const decodeOperationRequest = async (
  request: Request,
): Promise<InvitationBridgeOperation> => {
  const url = new URL(request.url);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();

  if (request.method !== "POST" || url.search !== "" || contentType !== "application/json") {
    throw InvitationBridgeFailureSchema.cases.InvitationDecodeError.make({message: "Invalid invitation response request"}) satisfies InvitationBridgeFailure;
  }

  const bytes = await readBoundedRequestBody(request);

  try {
    const value = parseJsonWithUniqueMembers(bytes);

    return decodeOperation(value);
  } catch {
    throw InvitationBridgeFailureSchema.cases.InvitationDecodeError.make({message: "Invalid invitation response request"}) satisfies InvitationBridgeFailure;
  }
};

export const runOperation = async (
  request: Request,
  operation: InvitationBridgeOperation,
) => {
  const client = createInvitationClient(invitationCapability(request));

  switch (operation.operation) {
    case "readInvitationResponse": {
      const result = await client.readInvitationResponse({ headers: {} });

      if (result.body === undefined) throw new Error("Invitation response did not include a body");

      return { observation: result.body, etag: result.headers.etag };
    }

    case "confirmInvitation":
      await client.confirmInvitation({
        params: {},
        headers: { "if-match": operation.etag },
        payload: {},
      });

      return undefined;
    case "rejectInvitation":
      await client.rejectInvitation({
        params: {},
        headers: { "if-match": operation.etag },
        payload: operation.message === null ? {} : { message: operation.message },
      });

      return undefined;
    case "requestNewInvitationTime":
      await client.requestNewInvitationTime({
        params: {},
        headers: { "if-match": operation.etag },
        payload: { message: operation.message },
      });

      return undefined;
  }
};

const safeFailure = (
  tag: InvitationBridgeFailure["_tag"],
  message: string,
): InvitationBridgeFailure => InvitationBridgeFailureSchema.cases[tag].make({message});

/**
 * Projects a bridge rejection or a generated-SDK failure onto the invitation bridge.
 * Pass the cause unchanged: an SDK problem is decoded only from the SDK's own value.
 */
export const bridgeFailureFrom = (cause: unknown): InvitationBridgeFailure => {
  if (S.is(InvitationBridgeFailureSchema)(cause)) {
    return Match.value(cause).pipe(
Match.tag("InvitationNotFound", () => {return safeFailure("InvitationNotFound", "Invitation unavailable");}),
Match.tag("InvitationAlreadyResponded", () => {return safeFailure("InvitationAlreadyResponded", "Invitation already responded");}),
Match.tag("InvitationDecodeError", () => {return safeFailure("InvitationDecodeError", "Invitation response input invalid");}),
Match.tag("InvitationUnavailable", () => {return safeFailure("InvitationUnavailable", "Invitation response unavailable");}),
Match.exhaustive
);
  }

  const problem = nativeProblemFrom(cause);

  if (problem === undefined) {
    return safeFailure("InvitationUnavailable", "Invitation response unavailable");
  }

  if (problem.status === 404) {
    return safeFailure("InvitationNotFound", "Invitation unavailable");
  }

  if (problem.code === "invitation.already-responded") {
    return safeFailure("InvitationAlreadyResponded", "Invitation already responded");
  }

  if (
    problem.status === 400 ||
    problem.status === 413 ||
    problem.status === 415 ||
    problem.status === 422
  ) {
    return safeFailure("InvitationDecodeError", "Invitation response input invalid");
  }

  return safeFailure("InvitationUnavailable", "Invitation response unavailable");
};

export const statusForInvitationFailure = (failure: InvitationBridgeFailure): number => {
  return Match.value(failure).pipe(
Match.tag("InvitationNotFound", () => {return 404;}),
Match.tag("InvitationAlreadyResponded", () => {return 409;}),
Match.tag("InvitationDecodeError", () => {return 422;}),
Match.tag("InvitationUnavailable", () => {return 503;}),
Match.exhaustive
);
};
