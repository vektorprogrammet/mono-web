import { UpdateOwnProfileCommand, UserProfile } from "@vektorprogrammet/sdk/effect";
import { Effect, Schema as S } from "effect";
import { toProfileBridgeFailure, type ProfileBridgeFailure } from "./bridge";
import type { ProfileCommand } from "./model";

export interface ProfileClient {
  readonly me: Readonly<{
    readonly profile: () => Effect.Effect<S.Schema.Type<typeof UserProfile>, ProfileBridgeFailure>;
    readonly updateProfile: (
      command: ProfileCommand,
    ) => Effect.Effect<S.Schema.Type<typeof UserProfile>, ProfileBridgeFailure>;
  }>;
}

interface BridgeResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly payload: unknown;
}

const profileEndpoint = "/dashboard/profile/rediger?index";

const statusTag = (status: number): string => {
  if (status === 401) return "Unauthorized";
  if (status === 403) return "Forbidden";
  if (status === 404) return "NotFound";
  if (status === 409) return "Conflict";
  if (status === 422) return "Validation";
  if (status === 429) return "RateLimited";
  if (status >= 500) return "Configuration";
  return "Network";
};

const failureFrom = (response: BridgeResponse): ProfileBridgeFailure =>
  toProfileBridgeFailure({ _tag: statusTag(response.status), message: "" });

const decodeProfile = (payload: unknown): S.Schema.Type<typeof UserProfile> =>
  S.decodeUnknownSync(UserProfile)(payload, { onExcessProperty: "error" });

const bridgeRequest = (
  method: "GET" | "PUT",
  body: unknown,
): Effect.Effect<BridgeResponse, ProfileBridgeFailure> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(profileEndpoint, {
        method,
        credentials: "same-origin",
        headers:
          method === "PUT"
            ? { "content-type": "application/json", accept: "application/json" }
            : { accept: "application/json" },
        body: method === "PUT" ? JSON.stringify(body) : undefined,
      });
      const payload: unknown = await response.json().catch(() => null);
      return { status: response.status, ok: response.ok, payload };
    },
    catch: (cause) => toProfileBridgeFailure(cause),
  });

const strictRead = bridgeRequest("GET", undefined).pipe(
  Effect.filterOrFail((response) => response.ok, failureFrom),
  Effect.map((response) => decodeProfile(response.payload)),
);

export const createBrowserProfileClient = (): ProfileClient => ({
  me: {
    profile: () => strictRead,
    updateProfile: (command: ProfileCommand) => {
      const encoded = S.encodeSync(UpdateOwnProfileCommand)(command);
      return bridgeRequest("PUT", encoded).pipe(
        Effect.filterOrFail((response) => response.ok, failureFrom),
        // The write response is never trusted as displayed state; the program
        // fresh-reads through the same strict GET boundary afterwards.
        Effect.flatMap(() => strictRead),
      );
    },
  },
});
