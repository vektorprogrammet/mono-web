import {
  IdempotencyKey,
  StrongETag,
  TeamApplicationCursor,
  TeamApplicationId,
  TeamApplicationIntakeMergePatch,
} from "@vektorprogrammet/http-api";
import { Effect, Match, Schema as S } from "effect";
import { Command, Dom } from "foldkit";
import type { TeamApplicationsFailure, TeamApplicationsOperations } from "./browser-client";
import {
  CompletedFocus,
  FailedDelete,
  FailedLoadPage,
  FailedReadApplication,
  FailedReviseIntake,
  SucceededDelete,
  SucceededLoadPage,
  SucceededReadApplication,
  SucceededReviseIntake,
  type Message,
} from "./message";
import { RequestId, TeamId, type MutationFailure, type ReadFailure } from "./model";

/** Maps a read failure to the state the page renders. Transport and server failures stay retryable. */
const readFailureFrom = (failure: TeamApplicationsFailure): ReadFailure =>
  Match.value(failure).pipe(
    Match.when(Match.is("authority.denied", "origin.denied"), (): ReadFailure => "Denied"),
    Match.when("resource.not-found", (): ReadFailure => "NotFound"),
    Match.when(
      Match.is("credential.missing", "credential.invalid"),
      (): ReadFailure => "SessionExpired",
    ),
    Match.orElse((): ReadFailure => "Unavailable"),
  );

/**
 * Maps a mutation failure to its outcome. Transport failures, server failures, in-flight
 * replays, and transaction conflicts are ambiguous or transient, so the same request may be
 * repeated with the same idempotency key. Every other problem is a definitive rejection.
 */
const mutationFailureFrom = (failure: TeamApplicationsFailure): MutationFailure =>
  Match.value(failure).pipe(
    Match.when("precondition.failed", (): MutationFailure => "Stale"),
    Match.when(Match.is("authority.denied", "origin.denied"), (): MutationFailure => "Denied"),
    Match.when("resource.not-found", (): MutationFailure => "NotFound"),
    Match.when(
      Match.is("credential.missing", "credential.invalid"),
      (): MutationFailure => "SessionExpired",
    ),
    Match.when("validation.no-change", (): MutationFailure => "NoChange"),
    Match.when(
      Match.is(
        "Transport",
        "idempotency.in-flight",
        "transaction.conflict",
        "internal.error",
        "idempotency.unavailable",
        "dependency.unavailable",
      ),
      (): MutationFailure => "Unavailable",
    ),
    Match.orElse((): MutationFailure => "Rejected"),
  );

export interface TeamApplicationsCommands {
  readonly LoadPage: (args: {
    readonly teamId: TeamId;
    readonly cursor: string | null;
    readonly requestId: number;
  }) => Command.Command<Message>;
  readonly ReadApplication: (args: {
    readonly applicationId: TeamApplicationId;
    readonly requestId: number;
  }) => Command.Command<Message>;
  readonly DeleteApplication: (args: {
    readonly applicationId: TeamApplicationId;
    readonly commandId: IdempotencyKey;
    readonly requestId: number;
  }) => Command.Command<Message>;
  readonly ReviseIntake: (args: {
    readonly teamId: TeamId;
    readonly etag: StrongETag;
    readonly patch: TeamApplicationIntakeMergePatch;
    readonly commandId: IdempotencyKey;
    readonly requestId: number;
  }) => Command.Command<Message>;
  readonly Focus: (args: { readonly selector: string }) => Command.Command<Message>;
}

export const commandsFor = (client: TeamApplicationsOperations): TeamApplicationsCommands => {
  const LoadPage = Command.define("LoadTeamApplicationPage", {
    args: { teamId: TeamId, cursor: S.NullOr(TeamApplicationCursor), requestId: RequestId },
    messages: [SucceededLoadPage, FailedLoadPage],
    execute: ({ teamId, cursor, requestId }) =>
      client.listApplications({ teamId, cursor }).pipe(
        Effect.map((page) => SucceededLoadPage({ requestId, page })),
        Effect.catch((error) =>
          Effect.succeed(FailedLoadPage({ requestId, failure: readFailureFrom(error) })),
        ),
      ),
  });

  const ReadApplication = Command.define("ReadTeamApplication", {
    args: { applicationId: TeamApplicationId, requestId: RequestId },
    messages: [SucceededReadApplication, FailedReadApplication],
    execute: ({ applicationId, requestId }) =>
      client.readApplication({ applicationId }).pipe(
        Effect.map((application) => SucceededReadApplication({ requestId, application })),
        Effect.catch((error) =>
          Effect.succeed(FailedReadApplication({ requestId, failure: readFailureFrom(error) })),
        ),
      ),
  });

  const DeleteApplication = Command.define("DeleteTeamApplication", {
    args: { applicationId: TeamApplicationId, commandId: IdempotencyKey, requestId: RequestId },
    messages: [SucceededDelete, FailedDelete],
    execute: ({ applicationId, commandId, requestId }) =>
      client.deleteApplication({ applicationId, commandId }).pipe(
        Effect.as(SucceededDelete({ requestId })),
        Effect.catch((error) =>
          Effect.succeed(FailedDelete({ requestId, failure: mutationFailureFrom(error) })),
        ),
      ),
  });

  const ReviseIntake = Command.define("ReviseTeamApplicationIntake", {
    args: {
      teamId: TeamId,
      etag: StrongETag,
      patch: TeamApplicationIntakeMergePatch,
      commandId: IdempotencyKey,
      requestId: RequestId,
    },
    messages: [SucceededReviseIntake, FailedReviseIntake],
    execute: ({ teamId, etag, patch, commandId, requestId }) =>
      client.reviseIntake({ teamId, etag, patch, commandId }).pipe(
        Effect.map((intake) => SucceededReviseIntake({ requestId, intake })),
        Effect.catch((error) =>
          Effect.succeed(FailedReviseIntake({ requestId, failure: mutationFailureFrom(error) })),
        ),
      ),
  });

  const Focus = Command.define("FocusTeamApplicationTarget", {
    args: { selector: S.String },
    messages: [CompletedFocus],
    execute: ({ selector }) =>
      Dom.focus(selector, { makeFocusable: true }).pipe(Effect.ignore, Effect.as(CompletedFocus())),
  });

  return { LoadPage, ReadApplication, DeleteApplication, ReviseIntake, Focus };
};
