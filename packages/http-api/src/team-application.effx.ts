import { Capability, Concealment, Http, Operation } from "@effx/runtime";
import {
  PublicTeamApplicationIntake,
  TeamApplicationConfirmation,
  TeamApplicationInput,
} from "@vektorprogrammet/domain/team-application";
import { HttpApiSchema } from "effect/unstable/httpapi";
import { ExternalNativeApi } from "./api.js";
import { PersonSecurity, nativeOperationAnnotations } from "./common.js";
import { nativeProblems } from "./endpoint-problems.js";
import {
  CreatedMutationResponseHeaders,
  EntityMutationResponseHeaders,
  IdempotencyHeaders,
  IdempotencyIfMatchHeaders,
  PrivateReadResponseHeaders,
} from "./http-semantics.js";
import {
  TeamApplicationEmptyInput,
  TeamApplicationListQuery,
  TeamApplicationParams,
  TeamApplicationTeamParams,
  TeamApplicationsByIdResolver,
  TeamApplicationsCreateResolver,
  TeamApplicationsDeleteCodes,
  TeamApplicationsIntakeByTeamResolver,
  TeamApplicationsListIntakesCodes,
  TeamApplicationsListResolver,
  TeamApplicationsNoStoreResponseHeaders,
  TeamApplicationsPublicIntakeResolver,
  TeamApplicationsPublicIntakesResolver,
  TeamApplicationsReadIntakeCodes,
  TeamApplicationsReviseIntakeCodes,
  TeamApplicationsStaffReadCodes,
  TeamApplicationsSubmitCodes,
  teamApplicationsAccessAnnotations,
} from "./team-application-effx-adapters.js";
import {
  TeamApplicationIntakeListResponse,
  TeamApplicationIntakeMergePatch,
  TeamApplicationIntakeResource,
  TeamApplicationListResponse,
  TeamApplicationResource,
} from "./team-application.js";

export const TeamApplicationsGroup = Http.group({
  root: ExternalNativeApi,
  group: "team-applications",
  title: "Team applications",
  description: "Public team intake, staff review, deletion, and intake settings.",
  defaults: {
    metadata: { annotator: nativeOperationAnnotations },
    problems: { registry: nativeProblems },
    access: {
      annotator: teamApplicationsAccessAnnotations,
      exposure: "External",
      concealment: Concealment.reveal,
    },
  },
});

export const ReadTeamApplicationIntake = Operation.query({
  name: "team-applications.readTeamApplicationIntake",
  input: TeamApplicationTeamParams,
  success: PublicTeamApplicationIntake,
})
  .in(TeamApplicationsGroup)
  .http.get("/api/teams/:teamId/application-intake")
  .http.contract({
    params: TeamApplicationTeamParams,
    responseHeaders: TeamApplicationsNoStoreResponseHeaders,
    middleware: [],
    metadata: {
      summary: "Read team application intake",
      description:
        "Returns whether one active team accepts applications now. Unknown and inactive teams are not found.",
    },
  })
  .http.problems({
    identifier: "TeamApplicationsReadIntakeProblem",
    codes: TeamApplicationsReadIntakeCodes,
  })
  .http.access({
    acceptedCredentials: ["None"],
    principalKinds: ["Anonymous"],
    capabilities: Capability.none,
    requirements: [],
    canonicalScopeResolver: TeamApplicationsPublicIntakeResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ListTeamApplicationIntakes = Operation.query({
  name: "team-applications.listTeamApplicationIntakes",
  input: TeamApplicationEmptyInput,
  success: TeamApplicationIntakeListResponse,
})
  .in(TeamApplicationsGroup)
  .http.get("/api/team-application-intakes")
  .http.contract({
    responseHeaders: TeamApplicationsNoStoreResponseHeaders,
    middleware: [],
    metadata: {
      summary: "List team application intakes",
      description: "Returns the intake state of at most 500 active teams.",
    },
  })
  .http.problems({
    identifier: "TeamApplicationsListIntakesProblem",
    codes: TeamApplicationsListIntakesCodes,
  })
  .http.access({
    acceptedCredentials: ["None"],
    principalKinds: ["Anonymous"],
    capabilities: Capability.none,
    requirements: [],
    canonicalScopeResolver: TeamApplicationsPublicIntakesResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const SubmitTeamApplication = Operation.command({
  name: "team-applications.submitTeamApplication",
  input: TeamApplicationInput,
  success: TeamApplicationConfirmation,
})
  .in(TeamApplicationsGroup)
  .http.post("/api/teams/:teamId/applications")
  .http.contract({
    params: TeamApplicationTeamParams,
    headers: IdempotencyHeaders,
    payload: TeamApplicationInput,
    status: 201,
    responseHeaders: CreatedMutationResponseHeaders,
    middleware: [],
    metadata: {
      summary: "Submit team application",
      description:
        "Stores one application to an open team and queues its receipt and team notification. An idempotency-key replay returns the original result. Every submission, including a replay, counts against one public rate limit.",
    },
  })
  .http.problems({
    identifier: "TeamApplicationsSubmitProblem",
    codes: TeamApplicationsSubmitCodes,
  })
  .http.access({
    acceptedCredentials: ["None"],
    principalKinds: ["Anonymous"],
    capabilities: Capability.none,
    requirements: [],
    canonicalScopeResolver: TeamApplicationsCreateResolver,
    decisionTime: "Transaction",
  })
  .declare();

export const ListTeamApplications = Operation.query({
  name: "team-applications.listTeamApplications",
  input: TeamApplicationListQuery,
  success: TeamApplicationListResponse,
})
  .in(TeamApplicationsGroup)
  .http.get("/api/teams/:teamId/applications")
  .http.contract({
    params: TeamApplicationTeamParams,
    query: TeamApplicationListQuery,
    responseHeaders: PrivateReadResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "List team applications",
      description:
        "Returns a bounded page of the team's applications to a current, nonsuspended member of that team.",
    },
  })
  .http.problems({
    identifier: "TeamApplicationsStaffReadProblem",
    codes: TeamApplicationsStaffReadCodes,
  })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("team-applications.read"),
    requirements: [],
    canonicalScopeResolver: TeamApplicationsListResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ReadTeamApplication = Operation.query({
  name: "team-applications.readTeamApplication",
  input: TeamApplicationParams,
  success: TeamApplicationResource,
})
  .in(TeamApplicationsGroup)
  .http.get("/api/team-applications/:applicationId")
  .http.contract({
    params: TeamApplicationParams,
    responseHeaders: PrivateReadResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Read team application",
      description: "Returns one application to a current, nonsuspended member of its team.",
    },
  })
  .http.problems({
    identifier: "TeamApplicationsStaffReadProblem",
    codes: TeamApplicationsStaffReadCodes,
  })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("team-applications.read"),
    requirements: [],
    canonicalScopeResolver: TeamApplicationsByIdResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const DeleteTeamApplication = Operation.command({
  name: "team-applications.deleteTeamApplication",
  input: TeamApplicationParams,
  success: HttpApiSchema.NoContent,
})
  .in(TeamApplicationsGroup)
  .http.delete("/api/team-applications/:applicationId")
  .http.contract({
    params: TeamApplicationParams,
    headers: IdempotencyHeaders,
    status: 204,
    responseHeaders: TeamApplicationsNoStoreResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Delete team application",
      description:
        "Removes one application and its undelivered notifications. Only the current team leader can delete.",
    },
  })
  .http.problems({
    identifier: "TeamApplicationsDeleteProblem",
    codes: TeamApplicationsDeleteCodes,
  })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("team-applications.manage"),
    requirements: [],
    canonicalScopeResolver: TeamApplicationsByIdResolver,
    decisionTime: "Transaction",
  })
  .declare();

export const ReviseTeamApplicationIntake = Operation.command({
  name: "team-applications.reviseTeamApplicationIntake",
  input: TeamApplicationIntakeMergePatch,
  success: TeamApplicationIntakeResource,
})
  .in(TeamApplicationsGroup)
  .http.patch("/api/teams/:teamId/application-intake")
  .http.contract({
    params: TeamApplicationTeamParams,
    headers: IdempotencyIfMatchHeaders,
    payload: TeamApplicationIntakeMergePatch,
    mediaType: "application/merge-patch+json",
    responseHeaders: EntityMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Revise team application intake",
      description:
        "Opens or closes intake and sets or clears the deadline. Requires the current team leader and the observed team entity tag.",
    },
  })
  .http.problems({
    identifier: "TeamApplicationsReviseIntakeProblem",
    codes: TeamApplicationsReviseIntakeCodes,
  })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("team-applications.manage"),
    requirements: [],
    canonicalScopeResolver: TeamApplicationsIntakeByTeamResolver,
    decisionTime: "Transaction",
  })
  .declare();
