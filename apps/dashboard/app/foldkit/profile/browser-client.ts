import { Effect, Schema as S } from "effect";
import { toProfileBridgeFailure, type ProfileBridgeFailure } from "./bridge";
import { ProfileCommand, ProfileInput, type ProfileInput as ProfileInputValue } from "./model";

export interface ProfileClient {
  readonly profile: {
    readonly updateOwnProfile: (
      command: typeof ProfileCommand.Type,
    ) => Effect.Effect<ProfileInputValue, ProfileBridgeFailure>;
  };
}

interface BridgeResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly payload: unknown;
}

const profileEndpoint = "/profile";

const statusTag = (status: number): string => {
  if (status === 401) return "Unauthorized";
  if (status === 403) return "Forbidden";
  if (status === 404) return "NotFound";
  if (status === 409 || status === 412 || status === 428) return "Conflict";
  if (status === 400 || status === 422) return "Validation";
  if (status === 429) return "RateLimited";
  if (status >= 500) return "Configuration";
  return "Network";
};

const failureFrom = (response: BridgeResponse): ProfileBridgeFailure =>
  toProfileBridgeFailure({ _tag: statusTag(response.status), message: "" });

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
          return { status: response.status, ok: response.ok, payload };
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
