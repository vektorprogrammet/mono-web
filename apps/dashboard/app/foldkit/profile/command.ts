import { Effect, Schema as S } from "effect";
import { Command } from "foldkit";
import { type ProfileBridgeFailure, toProfileBridgeFailure } from "./bridge";
import type { ProfileClient } from "./browser-client";
import { FailedProfileSave, SucceededProfileSave, type Message } from "./message";
import { ProfileCommand, type ProfileCommand as ProfileCommandValue } from "./model";

export interface ProfileCommands {
  readonly SaveProfile: (args: {
    readonly requestId: number;
    readonly command: ProfileCommandValue;
  }) => Command.Command<Message>;
}

const decodeFailure = (cause: unknown): ProfileBridgeFailure => {
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    const tag = cause._tag;
    if (typeof tag === "string") return toProfileBridgeFailure({ ...cause, _tag: tag });
  }
  return toProfileBridgeFailure(cause);
};

export const makeProfileCommands = (client: ProfileClient): ProfileCommands => {
  const SaveProfile = Command.define("SaveProfile", {
    args: { requestId: S.Int, command: ProfileCommand },
    messages: [SucceededProfileSave, FailedProfileSave],
    execute: ({ requestId, command }) =>
      client.profile.updateOwnProfile(command).pipe(
        Effect.map(({ profile, etag }) => SucceededProfileSave({ requestId, profile, etag })),
        Effect.catch((failure) =>
          Effect.succeed(FailedProfileSave({ requestId, failure: decodeFailure(failure) })),
        ),
      ),
  });

  return { SaveProfile };
};
