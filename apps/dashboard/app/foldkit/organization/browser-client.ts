import type {
  DepartmentJson,
  FieldOfStudyJson,
  InternalSdkError,
  TeamJson,
} from "@vektorprogrammet/sdk/effect";
import { apiUrl, createEffectClient } from "@vektorprogrammet/sdk/effect";
import type { Effect } from "effect";

export interface OrganizationCatalogOperations {
  readonly listDepartments: () => Effect.Effect<readonly DepartmentJson[], InternalSdkError>;
  readonly listTeams: () => Effect.Effect<readonly TeamJson[], InternalSdkError>;
  readonly listFieldOfStudies: () => Effect.Effect<readonly FieldOfStudyJson[], InternalSdkError>;
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
