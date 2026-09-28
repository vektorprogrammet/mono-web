/**
 * Team applications: public intake and submission, and staff review of one team's applications.
 *
 * Its operations are listed in docs/specs/rpc-only.md; the HTTP contract they replace is
 * `packages/http-api/src/team-application.ts` at the base commit named there.
 *
 * @since 0.3.0
 */
import { Team, TeamId } from "@vektorprogrammet/domain/organization";
import {
  PublicTeamApplicationIntake,
  TEAM_APPLICATION_INTAKE_LIST_LIMIT,
  TEAM_APPLICATION_PAGE_SIZE,
  TeamApplication,
  TeamApplicationConfirmation,
  TeamApplicationCursor,
  TeamApplicationId,
  TeamApplicationInput,
  TeamApplicationIntake,
  TeamApplicationIntakeListItem,
  TeamApplicationSummary,
} from "@vektorprogrammet/domain/team-application";
import { Rfc3339InstantSchema } from "@vektorprogrammet/domain/time";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { anonymousNativeAccess, personNativeAccess, withAccessSpec } from "./access.js";
import { PersonCredential } from "./credential.js";
import { IdempotencyKey, problemUnion, rpcProblems, StrongETag } from "./problem.js";

export {
  PublicTeamApplicationIntake,
  TeamApplicationConfirmation,
  TeamApplicationCursor,
  TeamApplicationId,
  TeamApplicationInput,
  TeamApplicationIntakeListItem,
  TeamApplicationSummary,
};

/** Staff intake settings with the team entity tag that `ifMatch` must repeat. */
export const TeamApplicationIntakeResource = Schema.Struct({
  ...TeamApplicationIntake.fields,
  etag: StrongETag,
}).annotate({
  identifier: "TeamApplicationIntakeResource",
  description: "Team intake settings, their open state now, and the team revision entity tag.",
});

export const TeamApplicationListResponse = Schema.Struct({
  teamId: TeamId,
  teamName: Team.fields.name,
  items: Schema.Array(TeamApplicationSummary).pipe(
    Schema.check(Schema.isMaxLength(TEAM_APPLICATION_PAGE_SIZE)),
  ),
  nextCursor: Schema.optional(TeamApplicationCursor),
  intake: TeamApplicationIntakeResource,
  canManage: Schema.Boolean,
}).annotate({
  identifier: "TeamApplicationListResponse",
  description:
    "One bounded newest-first page of a team's applications. canManage is a presentation projection.",
});

export const TeamApplicationResource = Schema.Struct({
  ...TeamApplication.fields,
  teamName: Team.fields.name,
  canManage: Schema.Boolean,
}).annotate({
  identifier: "TeamApplicationResource",
  description: "One application with its private applicant fields.",
});

export const TeamApplicationIntakeListResponse = Schema.Array(TeamApplicationIntakeListItem)
  .pipe(Schema.check(Schema.isMaxLength(TEAM_APPLICATION_INTAKE_LIST_LIMIT)))
  .annotate({
    identifier: "TeamApplicationIntakeListResponse",
    description: `Intake state for at most ${TEAM_APPLICATION_INTAKE_LIST_LIMIT} active teams, ordered by team identifier.`,
  });

/** Absence keeps a setting; a null deadline clears it; acceptApplication cannot be deleted. */
export const TeamApplicationIntakeMergePatch = Schema.Struct({
  acceptApplication: Schema.optional(Schema.NullOr(Schema.Boolean)),
  deadline: Schema.optional(Schema.NullOr(Rfc3339InstantSchema)),
}).annotate({ identifier: "TeamApplicationIntakeMergePatch" });

export type TeamApplicationIntakeMergePatch = typeof TeamApplicationIntakeMergePatch.Type;

export const TeamApplicationsReadIntakeProblem = problemUnion("TeamApplicationsReadIntakeProblem", [
  "resource.not-found",
  "internal.error",
]);

export const TeamApplicationsListIntakesProblem = problemUnion(
  "TeamApplicationsListIntakesProblem",
  ["internal.error"],
);

export const TeamApplicationsSubmitProblem = problemUnion("TeamApplicationsSubmitProblem", [
  "resource.not-found",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "team-application.intake-closed",
  "transaction.conflict",
  "rate-limit.exceeded",
  "internal.error",
  "idempotency.unavailable",
]);

/** A cursor that passes `TeamApplicationCursor` but names no position answers request.malformed. */
export const TeamApplicationsListProblem = problemUnion("TeamApplicationsListProblem", [
  "credential.missing",
  "credential.invalid",
  "request.malformed",
  "authority.denied",
  "resource.not-found",
  "internal.error",
]);

export const TeamApplicationsStaffReadProblem = problemUnion("TeamApplicationsStaffReadProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "resource.not-found",
  "internal.error",
]);

export const TeamApplicationsDeleteProblem = problemUnion("TeamApplicationsDeleteProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "resource.not-found",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "internal.error",
  "idempotency.unavailable",
]);

export const TeamApplicationsReviseIntakeProblem = problemUnion(
  "TeamApplicationsReviseIntakeProblem",
  [
    "credential.missing",
    "credential.invalid",
    "authority.denied",
    "idempotency.in-flight",
    "idempotency.digest-conflict",
    "idempotency.response-expired",
    "transaction.conflict",
    "precondition.failed",
    "validation.failed",
    "validation.no-change",
    "validation.field-not-deletable",
    "internal.error",
    "idempotency.unavailable",
  ],
);

/** Whether one active team accepts applications now. Unknown and inactive teams are not found. */
export const ReadTeamApplicationIntake = Rpc.make("team-applications.readTeamApplicationIntake", {
  payload: Schema.Struct({ teamId: TeamId }),
  success: PublicTeamApplicationIntake,
  error: rpcProblems(TeamApplicationsReadIntakeProblem),
}).pipe(withAccessSpec(anonymousNativeAccess("team-applications.public-intake")));

/** The intake state of at most `TEAM_APPLICATION_INTAKE_LIST_LIMIT` active teams. */
export const ListTeamApplicationIntakes = Rpc.make("team-applications.listTeamApplicationIntakes", {
  success: TeamApplicationIntakeListResponse,
  error: rpcProblems(TeamApplicationsListIntakesProblem),
}).pipe(withAccessSpec(anonymousNativeAccess("team-applications.public-intakes")));

/**
 * Stores one application to an open team and queues its receipt and team notification. An
 * idempotency-key replay returns the original result. Every submission, including a replay, counts
 * against one public rate limit.
 */
export const SubmitTeamApplication = Rpc.make("team-applications.submitTeamApplication", {
  payload: Schema.Struct({
    teamId: TeamId,
    idempotencyKey: IdempotencyKey,
    request: TeamApplicationInput,
  }),
  success: TeamApplicationConfirmation,
  error: rpcProblems(TeamApplicationsSubmitProblem),
}).pipe(
  withAccessSpec(anonymousNativeAccess("team-applications.application-create", "Transaction")),
);

/** A bounded page of the team's applications, to a current, nonsuspended member of that team. */
export const ListTeamApplications = Rpc.make("team-applications.listTeamApplications", {
  payload: Schema.Struct({ teamId: TeamId, cursor: Schema.optional(TeamApplicationCursor) }),
  success: TeamApplicationListResponse,
  error: rpcProblems(TeamApplicationsListProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "team-applications.read",
        canonicalScopeResolver: "team-applications.team-applications",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/** One application, to a current, nonsuspended member of its team. */
export const ReadTeamApplication = Rpc.make("team-applications.readTeamApplication", {
  payload: Schema.Struct({ applicationId: TeamApplicationId }),
  success: TeamApplicationResource,
  error: rpcProblems(TeamApplicationsStaffReadProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "team-applications.read",
        canonicalScopeResolver: "team-applications.application-by-id",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/**
 * Removes one application and its undelivered notifications. Only the current team leader can
 * delete.
 */
export const DeleteTeamApplication = Rpc.make("team-applications.deleteTeamApplication", {
  payload: Schema.Struct({ applicationId: TeamApplicationId, idempotencyKey: IdempotencyKey }),
  success: Schema.Void,
  error: rpcProblems(TeamApplicationsDeleteProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "team-applications.manage",
        canonicalScopeResolver: "team-applications.application-by-id",
        decisionTime: "Transaction",
      }),
    ),
  );

/**
 * Opens or closes intake and sets or clears the deadline (a JSON merge patch). Requires the current
 * team leader and the observed team entity tag.
 */
export const ReviseTeamApplicationIntake = Rpc.make(
  "team-applications.reviseTeamApplicationIntake",
  {
    payload: Schema.Struct({
      teamId: TeamId,
      idempotencyKey: IdempotencyKey,
      ifMatch: StrongETag,
      request: TeamApplicationIntakeMergePatch,
    }),
    success: TeamApplicationIntakeResource,
    error: rpcProblems(TeamApplicationsReviseIntakeProblem),
  },
)
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "team-applications.manage",
        canonicalScopeResolver: "team-applications.intake-by-team",
        decisionTime: "Transaction",
      }),
    ),
  );

export class TeamApplicationsRpcs extends RpcGroup.make(
  ReadTeamApplicationIntake,
  ListTeamApplicationIntakes,
  SubmitTeamApplication,
  ListTeamApplications,
  ReadTeamApplication,
  DeleteTeamApplication,
  ReviseTeamApplicationIntake,
) {}
