/**
 * Directory: people and schools.
 *
 * @since 0.3.0
 */
import {
  SchoolCommand,
  SchoolCommandResult,
  SchoolDirectoryQuerySchema,
  SchoolDirectorySchema,
  SchoolManagement,
  type SchoolDirectory,
  type SchoolDirectoryDepartment,
  type SchoolDirectoryEntry,
} from "@vektorprogrammet/domain/schools";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { personNativeAccess, withAccessSpec } from "./access.js";
import { PersonCredential } from "./credential.js";
import { IdempotencyKey, problemUnion, rpcProblems } from "./problem.js";

export {
  SchoolCommand,
  SchoolCommandResult,
  SchoolDirectoryQuerySchema,
  SchoolDirectorySchema,
  SchoolManagement,
};

export type { SchoolDirectory, SchoolDirectoryDepartment, SchoolDirectoryEntry };

/** One profile/organization directory row. */
export const PeopleDirectoryEntry = Schema.Struct({
  personId: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String,
  phone: Schema.String,
  /** Null until the Organization-owned association exists. */
  studyProgramme: Schema.Null,
  departments: Schema.Array(Schema.String),
  isActive: Schema.Boolean,
}).annotate({
  identifier: "PeopleDirectoryEntry",
  description: "Person profile enriched with Organization-owned department facts.",
});

export type PeopleDirectoryEntry = typeof PeopleDirectoryEntry.Type;

/** Complete scoped people directory response. */
export const PeopleDirectoryResponse = Schema.Struct({
  activePeople: Schema.Array(PeopleDirectoryEntry),
  inactivePeople: Schema.Array(PeopleDirectoryEntry),
  nextCursor: Schema.NullOr(Schema.String),
}).annotate({
  identifier: "PeopleDirectoryResponse",
  description: "Active and inactive people visible in the caller's authority scope.",
});

export type PeopleDirectoryResponse = typeof PeopleDirectoryResponse.Type;

export const ListPeopleProblem = problemUnion("ListPeopleProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "internal.error",
  "directory.unavailable",
]);

export const ListSchoolsProblem = problemUnion("ListSchoolsProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "internal.error",
  "schools.invalid-department",
  "schools.unavailable",
]);

export const SchoolManagementReadProblem = problemUnion("SchoolManagementReadProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "resource.not-found",
  "precondition.failed",
  "idempotency.digest-conflict",
  "schools.invalid-command",
  "schools.association-in-use",
  "schools.inactive",
  "schools.capacity-exists",
  "schools.unavailable",
  "internal.error",
]);

export const SchoolCommandProblem = problemUnion("SchoolCommandProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "resource.not-found",
  "precondition.failed",
  "schools.invalid-command",
  "schools.association-in-use",
  "schools.inactive",
  "schools.capacity-exists",
  "schools.unavailable",
  "idempotency.unavailable",
  "internal.error",
]);

/** The people directory within the caller's scope. */
export const ListPeople = Rpc.make("directory.listPeople", {
  success: PeopleDirectoryResponse,
  error: rpcProblems(ListPeopleProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "profile.read-directory",
        canonicalScopeResolver: "profile.people-directory",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/** The native school directory in authority scope, optionally of one department. */
export const ListSchools = Rpc.make("directory.listSchools", {
  payload: SchoolDirectoryQuerySchema,
  success: SchoolDirectorySchema,
  error: rpcProblems(ListSchoolsProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "schools.read-directory",
        canonicalScopeResolver: "schools.directory",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/** Authorized school facts, capacity plans, options, and history. */
export const ReadSchoolManagement = Rpc.make("directory.readSchoolManagement", {
  success: SchoolManagement,
  error: rpcProblems(SchoolManagementReadProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "schools.manage",
        canonicalScopeResolver: "schools.management",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/**
 * Applies one scoped school or capacity command with an explicit observed revision and atomic
 * history. The command's `commandId` must equal the idempotency key.
 */
export const ExecuteSchoolCommand = Rpc.make("directory.executeSchoolCommand", {
  payload: Schema.Struct({ idempotencyKey: IdempotencyKey, request: SchoolCommand }),
  success: SchoolCommandResult,
  error: rpcProblems(SchoolCommandProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "schools.manage",
        canonicalScopeResolver: "schools.management",
        decisionTime: "Transaction",
      }),
    ),
  );

export class DirectoryRpcs extends RpcGroup.make(
  ListPeople,
  ListSchools,
  ReadSchoolManagement,
  ExecuteSchoolCommand,
) {}
