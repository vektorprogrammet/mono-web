import { Effect, Schema as S } from "effect";
import {
  decodeInvitationInteractionId,
  InvitationBridgeFailureSchema,
  type InvitationBridgeFailure,
  type InvitationInteractionId,
  type InvitationResponseObservation,
  InvitationResponseObservationSchema,
  INVITATION_INTERACTION_HEADER,
} from "./bridge";

export interface InvitationResponseClient {
  readonly recruitmentInvitationResponses: Readonly<{
    readonly read: () => Effect.Effect<InvitationResponseObservation, InvitationBridgeFailure>;
    readonly confirm: () => Effect.Effect<void, InvitationBridgeFailure>;
    readonly reject: (input: {
      readonly message: string | null;
    }) => Effect.Effect<void, InvitationBridgeFailure>;
    readonly requestNewTime: (input: {
      readonly message: string;
    }) => Effect.Effect<void, InvitationBridgeFailure>;
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
    recruitmentInvitationResponses: {
      read: () =>
        bridgeRequest(decodedInteractionId, { operation: "readInvitationResponse" }, 200, (value) =>
          S.decodeUnknownSync(InvitationResponseObservationSchema)(value, {
            onExcessProperty: "error",
          }),
        ),
      confirm: () =>
        bridgeRequest(
          decodedInteractionId,
          { operation: "confirmInvitation" },
          204,
          () => undefined,
        ),
      reject: ({ message }) =>
        bridgeRequest(
          decodedInteractionId,
          { operation: "rejectInvitation", message },
          204,
          () => undefined,
        ),
      requestNewTime: ({ message }) =>
        bridgeRequest(
          decodedInteractionId,
          { operation: "requestNewInvitationTime", message },
          204,
          () => undefined,
        ),
    },
  };
};
