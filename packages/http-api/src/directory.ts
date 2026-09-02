/**
 * Public HTTP contracts for the people and school directories.
 *
 */
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { SchoolDirectorySchema, SchoolId } from "@vektorprogrammet/domain/schools";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { annotateAccessSpec, personNativeAccess } from "./access.js";
import { operationAnnotations, PersonSecurity } from "./common.js";
import { DirectoryListPeopleProblem, DirectoryListSchoolsProblem } from "./endpoint-problems.js";
import { endpointProblemResponses, privateReadResponse } from "./http-semantics.js";

/**
 * One profile/organization directory row.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const PeopleDirectoryEntry = Schema.Struct({
  personId: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String,
  phone: Schema.String,
  studyProgramme: Schema.Null,
  departments: Schema.Array(Schema.String),
  isActive: Schema.Boolean,
}).annotate({
  identifier: "PeopleDirectoryEntry",
  description: "Person profile enriched with Organization-owned department facts.",
  examples: [
    {
      personId: "7202",
      firstName: "Ming",
      lastName: "Medlem",
      email: "ming.medlem@example.org",
      phone: "+47 900 00 000",
      studyProgramme: null,
      departments: ["1"],
      isActive: true,
    },
  ],
});

/**
 * Complete scoped people directory response.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const PeopleDirectoryResponse = Schema.Struct({
  activePeople: Schema.Array(PeopleDirectoryEntry),
  inactivePeople: Schema.Array(PeopleDirectoryEntry),
  nextCursor: Schema.NullOr(Schema.String),
}).annotate({
  identifier: "PeopleDirectoryResponse",
  description: "Active and inactive people visible in the caller's authority scope.",
  examples: [
    {
      activePeople: [
        {
          personId: "7202",
          firstName: "Ming",
          lastName: "Medlem",
          email: "ming.medlem@example.org",
          phone: "+47 900 00 000",
          studyProgramme: null,
          departments: ["1"],
          isActive: true,
        },
      ],
      inactivePeople: [],
      nextCursor: null,
    },
  ],
});

/** @since 0.1.0 @category Endpoints */
export const ListPeopleEndpoint = HttpApiEndpoint.get("listPeople", "/api/people", {
  success: privateReadResponse(PeopleDirectoryResponse),
  error: endpointProblemResponses(DirectoryListPeopleProblem),
})
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "profile.read-directory",
        canonicalScopeResolver: "profile.people-directory",
        decisionTime: "SnapshotRead",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations("List people", "Returns the people directory within the caller's scope."),
  );

export const SchoolDirectoryExample = {
  activeSchools: [
    {
      schoolId: SchoolId.make(1),
      name: "Trondheim katedral videregående skole",
      contactPerson: "Heidi Holm",
      email: "post@tks.example.org",
      phone: "+47 900 00 001",
      language: "Norwegian",
      departments: [{ departmentId: DepartmentId.make("1"), name: "Trondheim" }],
      isActive: true,
    },
  ],
  inactiveSchools: [],
} as const;

/** @since 0.1.0 @category Endpoints */
export const ListSchoolsEndpoint = HttpApiEndpoint.get("listSchools", "/api/schools", {
  query: { department: Schema.optional(DepartmentId) },
  success: privateReadResponse(
    SchoolDirectorySchema.annotate({
      identifier: "SchoolDirectory",
      description: "Active and inactive school directory entries.",
      examples: [SchoolDirectoryExample],
    }),
  ),
  error: endpointProblemResponses(DirectoryListSchoolsProblem),
})
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "schools.read-directory",
        canonicalScopeResolver: "schools.directory",
        decisionTime: "SnapshotRead",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations("List schools", "Returns the native school directory in authority scope."),
  );

/**
 * Scoped people and school directory endpoints.
 *
 * @since 0.1.0
 * @category Groups
 */
export class DirectoryApi extends HttpApiGroup.make("directory")
  .add(ListPeopleEndpoint, ListSchoolsEndpoint)
  .annotateMerge(
    OpenApi.annotations({
      title: "Directories",
      description: "Scoped people and school directories.",
      override: { "x-displayName": "Directories" },
    }),
  ) {}
