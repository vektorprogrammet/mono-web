import { Effect, Schema as S } from "effect";
import {
  SocialEventListResource,
  SocialEventResource,
  SocialEventScopeResource,
  SocialEventsBridgeFailure,
  SocialEventsBridgeOperationJson,
  socialEventsBridgeFailure,
  type SocialEventsBridgeFailure as SocialEventsBridgeFailureType,
  type SocialEventsBridgeOperation,
  type SocialEventsCreateCommand as SocialEventsCreateCommandType,
  type SocialEventsListInput as SocialEventsListInputType,
} from "./bridge";

type SocialEventScope = S.Schema.Type<typeof SocialEventScopeResource>;

type SocialEventList = S.Schema.Type<typeof SocialEventListResource>;

type SocialEvent = S.Schema.Type<typeof SocialEventResource>;

export interface SocialEventsOperations {
  readonly readScope: () => Effect.Effect<SocialEventScope, SocialEventsBridgeFailureType>;
  readonly list: (
    input: SocialEventsListInputType,
  ) => Effect.Effect<SocialEventList, SocialEventsBridgeFailureType>;
  readonly create: (
    command: SocialEventsCreateCommandType,
  ) => Effect.Effect<SocialEvent, SocialEventsBridgeFailureType>;
}

export interface SocialEventsClient {
  readonly socialEvents: SocialEventsOperations;
}

const bridgeUrl = `${import.meta.env.BASE_URL}social-events`;

const bridgeRequest = <A>(
  schema: S.Decoder<A, never>,
  operation?: SocialEventsBridgeOperation,
): Effect.Effect<A, SocialEventsBridgeFailureType> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        bridgeUrl,
        operation === undefined
          ? {
              method: "GET",
              credentials: "same-origin",
              headers: { accept: "application/json" },
            }
          : {
              method: "POST",
              credentials: "same-origin",
              headers: {
                accept: "application/json",
                "content-type": "application/json",
              },
              body: S.encodeSync(SocialEventsBridgeOperationJson)(operation),
            },
      );

      const payload = (await response.json().catch(() => null));

      return { response, payload };
    },
    catch: () => socialEventsBridgeFailure("Network"),
  }).pipe(
    Effect.flatMap(({ response, payload }) => {
      if (!response.ok) {
        return S.decodeUnknownEffect(SocialEventsBridgeFailure)(payload, {
          onExcessProperty: "error",
        }).pipe(
          Effect.mapError(() => socialEventsBridgeFailure("SocialEventsDecodeError")),
          Effect.flatMap(Effect.fail),
        );
      }

      return S.decodeUnknownEffect(schema)(payload, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(() => socialEventsBridgeFailure("SocialEventsDecodeError")));
    }),
  );

export const createBrowserSocialEventsClient = (): SocialEventsClient => ({
  socialEvents: {
    readScope: () => bridgeRequest(SocialEventScopeResource),
    list: (query) =>
      bridgeRequest(SocialEventListResource, {
        operation: "list",
        query,
      }),
    create: (command) =>
      bridgeRequest(SocialEventResource, {
        operation: "create",
        ...command,
      }),
  },
});
