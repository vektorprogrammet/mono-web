/**
 * Public HTTP contracts for administrative directory reads.
 *
 */
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { SchoolDirectorySchema, SchoolId } from "@vektorprogrammet/domain/schools";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { errorBody, operationAnnotations, SessionSecurity } from "./common.js";

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
 * Complete scoped admin user directory response.
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

const DirectoryForbiddenResponse = errorBody(
  "DirectoryForbiddenResponse",
  ["InactiveActor", "NotInScope"],
  403,
);
const DirectoryDecodeResponse = errorBody(
  "DirectoryDecodeResponse",
  ["DirectoryCursorMalformed"],
  422,
);
const DirectoryUnavailableResponse = errorBody(
  "DirectoryUnavailableResponse",
  ["ProfileDecodeError", "ProfilePersistenceError"],
  503,
);

/** @since 0.1.0 @category Endpoints */
export const ListAdminUsersEndpoint = HttpApiEndpoint.get("listAdminUsers", "/api/admin/users", {
  success: PeopleDirectoryResponse,
  error: [DirectoryForbiddenResponse, DirectoryDecodeResponse, DirectoryUnavailableResponse],
})
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations(
      "List admin users",
      "Returns the person directory within the caller's scope.",
    ),
  );

const SchoolsForbiddenResponse = errorBody(
  "SchoolsForbiddenResponse",
  ["AuthorityInactive", "NotInScope", "SchoolsDepartmentOutOfScope"],
  403,
);
const SchoolsDecodeResponse = errorBody(
  "SchoolsDecodeResponse",
  ["SchoolsDecodeError", "SchoolsDepartmentNotFound"],
  422,
);
const SchoolsUnavailableResponse = errorBody(
  "SchoolsUnavailableResponse",
  ["SchoolsDecodeError", "SchoolsPersistenceError"],
  503,
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
export const ListSchoolsEndpoint = HttpApiEndpoint.get("listSchools", "/api/admin/schools", {
  query: { department: Schema.optional(DepartmentId) },
  success: SchoolDirectorySchema.annotate({
    identifier: "SchoolDirectory",
    description: "Active and inactive school directory entries.",
    examples: [SchoolDirectoryExample],
  }),
  error: [SchoolsForbiddenResponse, SchoolsDecodeResponse, SchoolsUnavailableResponse],
})
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations("List schools", "Returns the native school directory in authority scope."),
  );

/**
 * Scoped administrative directory endpoints.
 *
 * @since 0.1.0
 * @category Groups
 */
export class DirectoryApi extends HttpApiGroup.make("directory")
  .add(ListAdminUsersEndpoint, ListSchoolsEndpoint)
  .annotateMerge(
    OpenApi.annotations({
      title: "Directories",
      description: "Scoped administrative person and school directories.",
      override: { "x-displayName": "Directories" },
    }),
  ) {}
