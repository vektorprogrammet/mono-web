/**
 * Public HTTP contracts for administrative directory reads.
 *
 * @since 0.1.0
 */
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { SchoolDirectorySchema } from "@vektorprogrammet/domain/schools";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { errorBody, operationAnnotations, SessionSecurity } from "./common.js";

/**
 * One profile/organization directory row.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const AdminUserDirectoryEntry = Schema.Struct({
  personId: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String,
  phone: Schema.String,
  studyProgramme: Schema.Null,
  departments: Schema.Array(Schema.String),
  isActive: Schema.Boolean,
}).annotate({
  identifier: "AdminUserDirectoryEntry",
  description: "Person profile enriched with Organization-owned department facts.",
});

/**
 * Complete scoped admin user directory response.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const AdminUserDirectoryResponse = Schema.Struct({
  activeUsers: Schema.Array(AdminUserDirectoryEntry),
  inactiveUsers: Schema.Array(AdminUserDirectoryEntry),
  nextCursor: Schema.NullOr(Schema.String),
}).annotate({
  identifier: "AdminUserDirectoryResponse",
  description: "Active and inactive users visible in the caller's authority scope.",
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
  success: AdminUserDirectoryResponse,
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

/** @since 0.1.0 @category Endpoints */
export const ListSchoolsEndpoint = HttpApiEndpoint.get("listSchools", "/api/admin/schools", {
  query: { department: Schema.optional(DepartmentId) },
  success: SchoolDirectorySchema,
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
    }),
  ) {}
