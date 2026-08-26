import { Effect } from "effect";
import {
  DepartmentListSchema,
  FieldOfStudyListSchema,
  TeamListSchema,
  type DepartmentList,
  type FieldOfStudyList,
  type TeamList,
} from "../../schemas/organization.js";
import { OrganizationDecodeError, type InternalSdkError } from "../../errors.js";
import type { Transport } from "../../transport.js";

export interface PublicOrganizationDomain {
  listDepartments(): Effect.Effect<DepartmentList, InternalSdkError>;
  listTeams(): Effect.Effect<TeamList, InternalSdkError>;
  listFieldOfStudies(): Effect.Effect<FieldOfStudyList, InternalSdkError>;
}

const strictPublicOrganization = {
  strict: true,
  errorFamily: "organization" as const,
  decodeError: () => new OrganizationDecodeError(),
  includeCookie: false,
  expectedStatus: 200,
  headers: { Accept: "application/json" },
};

export const createPublicOrganizationDomain = (transport: Transport): PublicOrganizationDomain => ({
  listDepartments() {
    return transport.get(
      "/api/departments",
      DepartmentListSchema,
      undefined,
      strictPublicOrganization,
    );
  },

  listTeams() {
    return transport.get("/api/teams", TeamListSchema, undefined, strictPublicOrganization);
  },

  listFieldOfStudies() {
    return transport.get(
      "/api/field_of_studies",
      FieldOfStudyListSchema,
      undefined,
      strictPublicOrganization,
    );
  },
});
