import type { StrongETag } from "@vektorprogrammet/http-api";
import { Effect, flow, Option, Schema as S } from "effect";
import { decodeInvitationInteractionId, InvitationBridgeFailureSchema, InvitationResponseResourceSchema, INVITATION_INTERACTION_HEADER, type InvitationBridgeFailure, type InvitationInteractionId, type InvitationBridgeOperation, type InvitationResponseResource } from "./bridge";

export interface InvitationResponseClient {
  readonly recruitment: Readonly<{
    readonly readInvitationResponse: () => Effect.Effect<
      InvitationResponseResource,
      InvitationBridgeFailure
    >;
    readonly confirmInvitation: (input: {
      readonly etag: StrongETag;
    }) => Effect.Effect<void, InvitationBridgeFailure>;
    readonly rejectInvitation: (input: {
      readonly etag: StrongETag;
      readonly message: string | null;
    }) => Effect.Effect<void, InvitationBridgeFailure>;
    readonly requestNewInvitationTime: (input: {
      readonly etag: StrongETag;
      readonly message: string;
    }) => Effect.Effect<void, InvitationBridgeFailure>;
  }>;
}

const decodeFailure = S.decodeUnknownSync(InvitationBridgeFailureSchema, {onExcessProperty: "error"});

const toFailure = flow(
  S.decodeUnknownOption(InvitationBridgeFailureSchema, {onExcessProperty: "error"}),
  Option.getOrElse(() => InvitationBridgeFailureSchema.cases.InvitationUnavailable.make({message: "Invitation response bridge unavailable"})),
);

const invitationBridgeUrl = (): URL => {
  const routeUrl = new URL(globalThis.location.href);
  routeUrl.pathname = routeUrl.pathname.replace(/\/+$/u, "");

  return new URL("../interview", routeUrl);
};

const bridgeRequest = <A>(
  interactionId: InvitationInteractionId,
  body: InvitationBridgeOperation,
  expectedStatus: 200 | 204,
  schema: S.Decoder<A>,
): Effect.Effect<A, InvitationBridgeFailure> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(invitationBridgeUrl(), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          [INVITATION_INTERACTION_HEADER]: interactionId,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) throw decodeFailure(await response.json());

      if (response.status !== expectedStatus) {
        throw InvitationBridgeFailureSchema.cases.InvitationUnavailable.make({
          message: "Invitation response bridge unavailable",
        }) satisfies InvitationBridgeFailure;
      }

      return S.decodeUnknownSync(schema)(expectedStatus === 204 ? undefined : await response.json(), {onExcessProperty: "error"});
    },
    catch: toFailure,
  });

export const createBrowserInterviewClient = flow(decodeInvitationInteractionId, (decodedInteractionId): InvitationResponseClient => {

  return {
    recruitment: {
      readInvitationResponse: () =>
        bridgeRequest(
          decodedInteractionId,
          { operation: "readInvitationResponse" },
          200,
          InvitationResponseResourceSchema,
        ),
      confirmInvitation: ({ etag }) =>
        bridgeRequest(
          decodedInteractionId,
          { operation: "confirmInvitation", etag },
          204,
          S.Void,
        ),
      rejectInvitation: ({ etag, message }) =>
        bridgeRequest(
          decodedInteractionId,
          { operation: "rejectInvitation", etag, message },
          204,
          S.Void,
        ),
      requestNewInvitationTime: ({ etag, message }) =>
        bridgeRequest(
          decodedInteractionId,
          { operation: "requestNewInvitationTime", etag, message },
          204,
          S.Void,
        ),
    },
  };
});
