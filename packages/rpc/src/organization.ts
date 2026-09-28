/**
 * Organization: departments, teams, fields of study, team interest, mailing lists, delegations, lifecycle.
 *
 * @since 0.3.0
 */
import {
  DelegationCommand,
  DelegationManagement,
  DelegationResult,
} from "@vektorprogrammet/domain/authz";
import {
  AppointmentManagement,
  BoardRosters,
  DepartmentId,
  DepartmentJsonSchema,
  FieldOfStudyJsonSchema,
  OrganizationLifecycleCommand,
  OrganizationLifecycleResult,
  SemesterId,
  TeamJsonSchema,
  type DepartmentJson,
  type FieldOfStudyJson,
  type TeamJson,
} from "@vektorprogrammet/domain/organization";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { anonymousNativeAccess, personNativeAccess, withAccessSpec } from "./access.js";
import { PersonCredential } from "./credential.js";
import { IdempotencyKey, problemUnion, rpcProblems } from "./problem.js";
import {
  CreateDepartmentRequest,
  CreateFieldOfStudyRequest,
  CreateTeamRequest,
} from "./v2-schemas.js";

export {
  AppointmentManagement,
  BoardRosters,
  DelegationCommand,
  DelegationManagement,
  DelegationResult,
  DepartmentJsonSchema,
  FieldOfStudyJsonSchema,
  OrganizationLifecycleCommand,
  OrganizationLifecycleResult,
  TeamJsonSchema,
};

export type { DepartmentJson, FieldOfStudyJson, TeamJson };

/** The department and semester that a team-interest read narrows to; both are optional. */
export const TeamInterestQuery = Schema.Struct({
  departmentId: Schema.optional(DepartmentId),
  semesterId: Schema.optional(SemesterId),
}).annotate({ identifier: "TeamInterestQuery" });

export type TeamInterestQuery = typeof TeamInterestQuery.Type;

/** The mailing lists that a projection selects. */
export const MailingListType = Schema.Literals(["assistants", "team", "all"]);

export type MailingListType = typeof MailingListType.Type;

/**
 * The department, semester, and list type that a mailing-list projection selects. An absent
 * `type` selects the assistants.
 */
export const MailingListQuery = Schema.Struct({
  departmentId: Schema.optional(DepartmentId),
  semesterId: Schema.optional(SemesterId),
  type: Schema.optional(MailingListType),
}).annotate({ identifier: "MailingListQuery" });

export type MailingListQuery = typeof MailingListQuery.Type;

/** Strict team-interest response compatible with the existing Hydra envelope. */
export const TeamInterestResponse = Schema.Struct({
  "hydra:member": Schema.Array(
    Schema.Struct({ id: Schema.Int, userName: Schema.String, teamName: Schema.String }),
  ),
  "hydra:totalItems": Schema.Int,
}).annotate({ identifier: "TeamInterestResponse", description: "Scoped team-interest rows." });

export type TeamInterestResponse = typeof TeamInterestResponse.Type;

/** Projected mailing lists. */
export const MailingListResponse = Schema.Array(
  Schema.Struct({ name: Schema.String, emails: Schema.Array(Schema.String) }),
).annotate({
  identifier: "MailingListResponse",
  description: "Scoped mailing-list projections.",
});

export type MailingListResponse = typeof MailingListResponse.Type;

export const ListDepartmentsProblem = problemUnion(
  "ListDepartmentsProblem",
  ["internal.error", "organization.unavailable"],
);

export const ListTeamsProblem = problemUnion("ListTeamsProblem", [
  "internal.error",
  "organization.unavailable",
]);

export const ListFieldOfStudiesProblem = problemUnion(
  "ListFieldOfStudiesProblem",
  ["internal.error", "organization.unavailable"],
);

export const ListTeamInterestProblem = problemUnion(
  "ListTeamInterestProblem",
  [
    "credential.missing",
    "credential.invalid",
    "authority.denied",
    "internal.error",
    "organization.invalid-reference",
    "organization.unavailable",
  ],
);

export const ListMailingListsProblem = problemUnion(
  "ListMailingListsProblem",
  [
    "credential.missing",
    "credential.invalid",
    "authority.denied",
    "internal.error",
    "organization.invalid-reference",
    "organization.unavailable",
  ],
);

export const CreateDepartmentProblem = problemUnion(
  "CreateDepartmentProblem",
  [
    "credential.missing",
    "credential.invalid",
    "authority.denied",
    "idempotency.in-flight",
    "idempotency.digest-conflict",
    "idempotency.response-expired",
    "transaction.conflict",
    "internal.error",
    "idempotency.unavailable",
    "organization.invalid-reference",
    "organization.unavailable",
  ],
);

export const CreateTeamProblem = problemUnion("CreateTeamProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "internal.error",
  "idempotency.unavailable",
  "organization.invalid-reference",
  "organization.unavailable",
]);

export const CreateFieldOfStudyProblem = problemUnion(
  "CreateFieldOfStudyProblem",
  [
    "credential.missing",
    "credential.invalid",
    "authority.denied",
    "idempotency.in-flight",
    "idempotency.digest-conflict",
    "idempotency.response-expired",
    "transaction.conflict",
    "internal.error",
    "idempotency.unavailable",
    "organization.invalid-reference",
    "organization.unavailable",
  ],
);

/** Appointment and delegation management: their reads and their commands. */
export const OrganizationLifecycleProblem = problemUnion("OrganizationLifecycleProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "resource.not-found",
  "precondition.failed",
  "validation.failed",
  "idempotency.digest-conflict",
  "idempotency.in-flight",
  "idempotency.response-expired",
  "transaction.conflict",
  "internal.error",
  "idempotency.unavailable",
  "organization.unavailable",
]);

/** The public native department directory. */
export const ListDepartments = Rpc.make("organization.listDepartments", {
  success: Schema.Array(DepartmentJsonSchema),
  error: rpcProblems(ListDepartmentsProblem),
}).pipe(withAccessSpec(anonymousNativeAccess("organization.public-departments")));

/** The public native team directory. */
export const ListTeams = Rpc.make("organization.listTeams", {
  success: Schema.Array(TeamJsonSchema),
  error: rpcProblems(ListTeamsProblem),
}).pipe(withAccessSpec(anonymousNativeAccess("organization.public-teams")));

/** The public native study directory. */
export const ListFieldOfStudies = Rpc.make("organization.listFieldOfStudies", {
  success: Schema.Array(FieldOfStudyJsonSchema),
  error: rpcProblems(ListFieldOfStudiesProblem),
}).pipe(withAccessSpec(anonymousNativeAccess("organization.public-field-of-studies")));

/**
 * Registrations within the caller's team-interest reach: the own team for its leader, whole
 * departments for department reach.
 */
export const ListTeamInterest = Rpc.make("organization.listTeamInterest", {
  payload: TeamInterestQuery,
  success: TeamInterestResponse,
  error: rpcProblems(ListTeamInterestProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "organization.read-team-interest",
        canonicalScopeResolver: "organization.team-interest-registrations",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/** Projects addresses within the departments where the caller reads people. */
export const ListMailingLists = Rpc.make("organization.listMailingLists", {
  payload: MailingListQuery,
  success: MailingListResponse,
  error: rpcProblems(ListMailingListsProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "organization.read-mailing-lists",
        canonicalScopeResolver: "organization.mailing-lists",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/** Creates, or replays by its idempotency key, one department. */
export const CreateDepartment = Rpc.make("organization.createDepartment", {
  payload: Schema.Struct({ idempotencyKey: IdempotencyKey, request: CreateDepartmentRequest }),
  success: DepartmentJsonSchema,
  error: rpcProblems(CreateDepartmentProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "organization.create-department",
        canonicalScopeResolver: "organization.department-create",
        decisionTime: "Transaction",
      }),
    ),
  );

/** Creates, or replays by its idempotency key, one team. */
export const CreateTeam = Rpc.make("organization.createTeam", {
  payload: Schema.Struct({ idempotencyKey: IdempotencyKey, request: CreateTeamRequest }),
  success: TeamJsonSchema,
  error: rpcProblems(CreateTeamProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "organization.create-team",
        canonicalScopeResolver: "organization.team-create",
        decisionTime: "Transaction",
      }),
    ),
  );

/** Creates, or replays by its idempotency key, one field of study. */
export const CreateFieldOfStudy = Rpc.make("organization.createFieldOfStudy", {
  payload: Schema.Struct({ idempotencyKey: IdempotencyKey, request: CreateFieldOfStudyRequest }),
  success: FieldOfStudyJsonSchema,
  error: rpcProblems(CreateFieldOfStudyProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "organization.create-field-of-study",
        canonicalScopeResolver: "organization.field-of-study-create",
        decisionTime: "Transaction",
      }),
    ),
  );

/** Authorized people, units, appointments, account access and history. */
export const ReadAppointmentManagement = Rpc.make("organization.readAppointmentManagement", {
  success: AppointmentManagement,
  error: rpcProblems(OrganizationLifecycleProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "organization.manage-appointments",
        canonicalScopeResolver: "organization.appointment-management",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/**
 * The rosters of Styret of an independent department and of Hovedstyret: the appointed seats and
 * the seats that current team leadership derives, for the boards whose appointments the reader
 * manages, as of the request instant.
 */
export const ReadBoardRosters = Rpc.make("organization.readBoardRosters", {
  success: BoardRosters,
  error: rpcProblems(OrganizationLifecycleProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "organization.manage-appointments",
        canonicalScopeResolver: "organization.appointment-management",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/**
 * Applies one authorized, revision-checked lifecycle command with atomic history. The command's
 * `commandId` must equal the idempotency key.
 */
export const ExecuteLifecycle = Rpc.make("organization.executeLifecycle", {
  payload: Schema.Struct({ idempotencyKey: IdempotencyKey, request: OrganizationLifecycleCommand }),
  success: OrganizationLifecycleResult,
  error: rpcProblems(OrganizationLifecycleProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "organization.manage-appointments",
        canonicalScopeResolver: "organization.appointment-management",
        decisionTime: "Transaction",
      }),
    ),
  );

/**
 * The delegations that one person manages: a Styret leader those of its department's teams,
 * Hovedstyret or a global administrator those of national teams.
 */
export const ReadDelegationManagement = Rpc.make("organization.readDelegationManagement", {
  success: DelegationManagement,
  error: rpcProblems(OrganizationLifecycleProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "organization.manage-delegations",
        canonicalScopeResolver: "organization.delegation-management",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/**
 * Issues or ends one named, time-bounded delegation with atomic history under current authority.
 * The command's `commandId` must equal the idempotency key.
 */
export const ExecuteDelegation = Rpc.make("organization.executeDelegation", {
  payload: Schema.Struct({ idempotencyKey: IdempotencyKey, request: DelegationCommand }),
  success: DelegationResult,
  error: rpcProblems(OrganizationLifecycleProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "organization.manage-delegations",
        canonicalScopeResolver: "organization.delegation-management",
        decisionTime: "Transaction",
      }),
    ),
  );

export class OrganizationRpcs extends RpcGroup.make(
  ListDepartments,
  ListTeams,
  ListFieldOfStudies,
  ListTeamInterest,
  ListMailingLists,
  CreateDepartment,
  CreateTeam,
  CreateFieldOfStudy,
  ReadAppointmentManagement,
  ReadBoardRosters,
  ExecuteLifecycle,
  ReadDelegationManagement,
  ExecuteDelegation,
) {}
