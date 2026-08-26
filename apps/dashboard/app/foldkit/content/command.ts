import type { InternalSdkError } from "@vektorprogrammet/sdk/effect";
import { Effect, Schema as S } from "effect";
import { Command } from "foldkit";
import type { ContentWorkspaceClient } from "./browser-client";
import { FailedCommand, FailedWorkspace, LoadedWorkspace, type Message } from "./message";
import type {
  CreateContentDraftCommand,
  PublicationTransitionCommand,
  ReviseContentDraftCommand,
} from "@vektorprogrammet/sdk/effect";
import type { WorkspaceCommandFactories } from "./update";

export interface ContentWorkspaceCommands {
  readonly LoadWorkspace: (args: { readonly requestId: number }) => Command.Command<Message>;
}

const failureFrom = (
  error: InternalSdkError,
): {
  readonly _tag: "Denied" | "Failed";
  readonly message: string;
} => {
  if (error instanceof Error && "contentTag" in error) {
    const tag = String((error as { readonly contentTag: unknown }).contentTag);
    switch (tag) {
      case "UnauthenticatedActor":
        return { _tag: "Denied", message: "Økten din er utløpt. Logg inn på nytt." };
      case "AuthorityInactive":
        return {
          _tag: "Denied",
          message: "Tilgangen din til artikkeladministrasjon er ikke aktiv.",
        };
      case "NotInScope":
        return { _tag: "Denied", message: "Du har ikke tilgang til artikkeladministrasjon." };
      case "NotPublisher":
        return {
          _tag: "Denied",
          message: "Kun ledere og administratorer kan publisere, avpublisere eller endre reklame.",
        };
      case "DraftNotOwned":
        return { _tag: "Denied", message: "Du kan bare redigere egne kladder." };
      case "SlugConflict":
        return { _tag: "Failed", message: "Lenkenavnet er allerede i bruk. Prøv et annet navn." };
      case "CommandConflict":
        return {
          _tag: "Failed",
          message: "Artikkelen er endret av andre samtidig. Last siden på nytt.",
        };
      default:
        break;
    }
  }
  return { _tag: "Failed", message: "Artikkeladministrasjonen kunne ikke hentes. Prøv på nytt." };
};

export interface WorkspaceCommandDeps {
  /** Issues one command; the bridge resolves it server-side. */
  readonly createDraft: (
    command: CreateContentDraftCommand,
    requestId: number,
  ) => Command.Command<Message>;
  readonly reviseDraft: (
    command: ReviseContentDraftCommand,
    requestId: number,
  ) => Command.Command<Message>;
  readonly publish: (
    command: PublicationTransitionCommand,
    requestId: number,
  ) => Command.Command<Message>;
  readonly unpublish: (
    command: PublicationTransitionCommand,
    requestId: number,
  ) => Command.Command<Message>;
}

export const makeContentWorkspaceCommands = (
  client: ContentWorkspaceClient,
): WorkspaceCommandFactories => {
  return {
    LoadWorkspace: (({ requestId }) => ({
      name: "LoadContentWorkspace",
      args: { requestId },
      effect: client.admin.content.workspace().pipe(
        Effect.map((workspace) => LoadedWorkspace({ requestId, workspace })),
        Effect.catch((error) =>
          Effect.succeed(FailedWorkspace({ requestId, failure: failureFrom(error) })),
        ),
      ),
    })) as WorkspaceCommandFactories["LoadWorkspace"],
  };
};

export { failureFrom };
