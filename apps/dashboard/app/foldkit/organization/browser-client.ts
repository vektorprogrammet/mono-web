import type {
  DepartmentJson,
  FieldOfStudyJson,
  InternalSdkError,
  TeamJson,
} from "@vektorprogrammet/sdk/effect";
import { apiUrl, createEffectClient } from "@vektorprogrammet/sdk/effect";
import type { Effect } from "effect";

export interface OrganizationCatalogOperations {
  readonly listDepartments: () => Effect.Effect<DepartmentJson[], InternalSdkError>;
  readonly listTeams: () => Effect.Effect<TeamJson[], InternalSdkError>;
  readonly listFieldOfStudies: () => Effect.Effect<FieldOfStudyJson[], InternalSdkError>;
}

export interface OrganizationCatalogClient {
  readonly public: {
    readonly organization: OrganizationCatalogOperations;
  };
}

export const createBrowserOrganizationCatalogClient = (): OrganizationCatalogClient => {
  const client = createEffectClient(apiUrl);
  return {
    public: {
      organization: client.public.organization,
    },
  };
};
