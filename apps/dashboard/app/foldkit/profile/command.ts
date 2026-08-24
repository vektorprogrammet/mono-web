import { UpdateOwnProfileCommand } from "@vektorprogrammet/sdk/effect";
import { Effect, Schema as S } from "effect";
import { Command } from "foldkit";
import {
  type ProfileBridgeFailure,
  toProfileBridgeFailure,
} from "./bridge";
import type { ProfileRequestId } from "./bridge";
import type { ProfileClient } from "./browser-client";
import {
  FailedProfileSave,
  FailedReadProfile,
  SucceededProfileSave,
  SucceededReadProfile,
  type Message,
} from "./message";
import type { ProfileCommand } from "./model";

export interface ProfileCommands {
  readonly ReadProfile: (args: {
    readonly requestId: number;
  }) => Command.Command<Message>;
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
  const ReadProfile = Command.define("ReadProfile", {
    args: { requestId: S.Int },
    messages: [SucceededReadProfile, FailedReadProfile],
    execute: ({ requestId }) =>
      client.me.profile().pipe(
        Effect.map((profile) => SucceededReadProfile({ requestId, profile })),
        Effect.catch((failure) =>
          Effect.succeed(FailedReadProfile({ requestId, failure: decodeFailure(failure) })),
        ),
      ),
  });

  const SaveProfile = Command.define("SaveProfile", {
    args: { requestId: S.Int, command: UpdateOwnProfileCommand },
    messages: [SucceededProfileSave, FailedProfileSave],
    execute: ({ requestId, command }) =>
      client.me.updateProfile(command).pipe(
        Effect.flatMap(() => client.me.profile()),
        Effect.map((fresh) =>
          SucceededProfileSave({
            requestId,
            commandId: command.commandId,
            profile: fresh,
          }),
        ),
        Effect.catch((failure) =>
          Effect.succeed(FailedProfileSave({ requestId, failure: decodeFailure(failure) })),
        ),
      ),
  });

  return { ReadProfile, SaveProfile };
};
