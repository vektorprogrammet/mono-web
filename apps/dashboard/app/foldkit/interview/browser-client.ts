import type { StrongETag } from "@vektorprogrammet/http-api";
import { Effect, Schema as S } from "effect";
import {
  decodeInvitationInteractionId,
  InvitationBridgeFailureSchema,
  InvitationResponseResourceSchema,
  INVITATION_INTERACTION_HEADER,
  type InvitationBridgeFailure,
  type InvitationInteractionId,
  type InvitationResponseResource,
} from "./bridge";

export interface InvitationResponseClient {
  readonly recruitment: Readonly<{
    readonly readInvitationResponse: () => Effect.Effect<
      InvitationResponseResource,
      InvitationBridgeFailure
    >;
    readonly confirmInvitation: (input: {
      readonly etag: StrongETag;
    }) => Effect.Effect<InvitationResponseResource, InvitationBridgeFailure>;
    readonly rejectInvitation: (input: {
      readonly etag: StrongETag;
      readonly message: string | null;
    }) => Effect.Effect<InvitationResponseResource, InvitationBridgeFailure>;
    readonly requestNewInvitationTime: (input: {
      readonly etag: StrongETag;
      readonly message: string;
    }) => Effect.Effect<InvitationResponseResource, InvitationBridgeFailure>;
  }>;
}

const decodeFailure = (value: unknown): InvitationBridgeFailure =>
  S.decodeUnknownSync(InvitationBridgeFailureSchema)(value, {
    onExcessProperty: "error",
  });

const toFailure = (cause: unknown): InvitationBridgeFailure => {
  try {
    return decodeFailure(cause);
  } catch {
    return {
      _tag: "InvitationUnavailable",
      message: "Invitation response bridge unavailable",
    };
  }
};
const decodeResource = (value: unknown): InvitationResponseResource =>
  S.decodeUnknownSync(InvitationResponseResourceSchema)(value, {
    onExcessProperty: "error",
  });

const bridgeRequest = <A>(
  interactionId: InvitationInteractionId,
  body: Record<string, unknown>,
  expectedStatus: 200 | 204,
  decode: (value: unknown) => A,
): Effect.Effect<A, InvitationBridgeFailure> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch("/interview", {
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
        throw {
          _tag: "InvitationUnavailable",
          message: "Invitation response bridge unavailable",
        } satisfies InvitationBridgeFailure;
      }
      return expectedStatus === 204 ? decode(undefined) : decode(await response.json());
    },
    catch: toFailure,
  });

export const createBrowserInterviewClient = (interactionId: unknown): InvitationResponseClient => {
  const decodedInteractionId = decodeInvitationInteractionId(interactionId);
  return {
    recruitment: {
      readInvitationResponse: () =>
        bridgeRequest(
          decodedInteractionId,
          { operation: "readInvitationResponse" },
          200,
          decodeResource,
        ),
      confirmInvitation: ({ etag }) =>
        bridgeRequest(
          decodedInteractionId,
          { operation: "confirmInvitation", etag },
          200,
          decodeResource,
        ),
      rejectInvitation: ({ etag, message }) =>
        bridgeRequest(
          decodedInteractionId,
          { operation: "rejectInvitation", etag, message },
          200,
          decodeResource,
        ),
      requestNewInvitationTime: ({ etag, message }) =>
        bridgeRequest(
          decodedInteractionId,
          { operation: "requestNewInvitationTime", etag, message },
          200,
          decodeResource,
        ),
    },
  };
};
