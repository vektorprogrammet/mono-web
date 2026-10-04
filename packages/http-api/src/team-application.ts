/**
 * Public intake and staff review contracts for standalone team applications.
 *
 * @since 0.2.0
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
import {
  TeamApplicationsDeleteCodes,
  TeamApplicationsListIntakesCodes,
  TeamApplicationsReadIntakeCodes,
  TeamApplicationsReviseIntakeCodes,
  TeamApplicationsStaffReadCodes,
  TeamApplicationsSubmitCodes,
} from "./team-application-effx-adapters.js";
import { problemUnion, StrongETag } from "./http-semantics.js";

export {
  PublicTeamApplicationIntake,
  TeamApplicationConfirmation,
  TeamApplicationCursor,
  TeamApplicationId,
  TeamApplicationInput,
  TeamApplicationIntakeListItem,
  TeamApplicationSummary,
};

/** Staff intake settings with the team entity tag that `If-Match` must repeat. */
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

export const TeamApplicationsReadIntakeProblem = problemUnion(
  "TeamApplicationsReadIntakeProblem",
  TeamApplicationsReadIntakeCodes,
);

export const TeamApplicationsListIntakesProblem = problemUnion(
  "TeamApplicationsListIntakesProblem",
  TeamApplicationsListIntakesCodes,
);

export const TeamApplicationsSubmitProblem = problemUnion(
  "TeamApplicationsSubmitProblem",
  TeamApplicationsSubmitCodes,
);

export const TeamApplicationsStaffReadProblem = problemUnion(
  "TeamApplicationsStaffReadProblem",
  TeamApplicationsStaffReadCodes,
);

export const TeamApplicationsDeleteProblem = problemUnion(
  "TeamApplicationsDeleteProblem",
  TeamApplicationsDeleteCodes,
);

export const TeamApplicationsReviseIntakeProblem = problemUnion(
  "TeamApplicationsReviseIntakeProblem",
  TeamApplicationsReviseIntakeCodes,
);
