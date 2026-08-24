import { UpdateOwnProfileCommand } from "@vektorprogrammet/sdk/effect";
import { Effect, Schema as S } from "effect";
import { Command } from "foldkit";
import { type ProfileBridgeFailure, toProfileBridgeFailure } from "./bridge";
import type { ProfileClient } from "./browser-client";
import {
  FailedProfileSave,
  SucceededProfileSave,
  type Message,
} from "./message";
import type { ProfileCommand } from "./model";

export interface ProfileCommands {
  readonly SaveProfile: (args: {
    readonly requestId: number;
    readonly command: ProfileCommand;
  }) => Command.Command<Message>;
}

const decodeFailure = (cause: unknown): ProfileBridgeFailure => {
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    const tag = cause._tag;
    if (typeof tag === "string") return toProfileBridgeFailure({ ...cause, _tag: tag });
  }
  if (typeof cause === "object" && cause !== null && "tag" in cause) {
    const tag = cause.tag;
    if (typeof tag === "string") return toProfileBridgeFailure({ _tag: tag, message: "" });
  }
  return toProfileBridgeFailure(cause);
};

export const makeProfileCommands = (client: ProfileClient): ProfileCommands => {
  const SaveProfile = Command.define("SaveProfile", {
    args: { requestId: S.Int, command: UpdateOwnProfileCommand },
    messages: [SucceededProfileSave, FailedProfileSave],
    execute: ({ requestId, command }) =>
      client.updateProfile(command).pipe(
        Effect.map((profile) =>
          SucceededProfileSave({
            requestId,
            commandId: command.commandId,
            profile,
          }),
        ),
        Effect.catch((failure) =>
          Effect.succeed(FailedProfileSave({ requestId, failure: decodeFailure(failure) })),
        ),
      ),
  });

  return { SaveProfile };
};
