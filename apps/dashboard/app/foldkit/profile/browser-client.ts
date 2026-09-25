import { Effect, Option, Schema as S } from "effect";
import { ProfileBridgeFailure, toProfileBridgeFailure } from "./bridge";
import { ProfileCommand, ProfileInput, type ProfileInput as ProfileInputValue } from "./model";

export interface ProfileClient {
  readonly profile: {
    readonly updateOwnProfile: (
      command: typeof ProfileCommand.Type,
    ) => Effect.Effect<ProfileInputValue, ProfileBridgeFailure>;
  };
}

interface BridgeResponse {
  readonly ok: boolean;
  readonly payload: unknown;
}

const profileEndpoint = "/profile";

/** The profile route answers a failure with its typed bridge failure; anything else is unexpected. */
const failureFrom = (response: BridgeResponse): ProfileBridgeFailure =>
  S.decodeUnknownOption(ProfileBridgeFailure, { onExcessProperty: "error" })(response.payload).pipe(
    Option.getOrElse(() => toProfileBridgeFailure(response.payload)),
  );

export const createBrowserProfileClient = (): ProfileClient => ({
  profile: {
    updateOwnProfile: (command) => {
      const encoded = S.encodeSync(ProfileCommand)(command);

      return Effect.tryPromise({
        try: async () => {
          const response = await fetch(profileEndpoint, {
            method: "PUT",
            credentials: "same-origin",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(encoded),
          });

          const payload: unknown = await response.json().catch(() => null);

          return { ok: response.ok, payload };
        },
        catch: (cause) => toProfileBridgeFailure(cause),
      }).pipe(
        Effect.filterOrFail((response) => response.ok, failureFrom),
        Effect.flatMap((response) =>
          S.decodeUnknownEffect(ProfileInput)(response.payload, { onExcessProperty: "error" }).pipe(
            Effect.mapError(toProfileBridgeFailure),
          ),
        ),
      );
    },
  },
});
