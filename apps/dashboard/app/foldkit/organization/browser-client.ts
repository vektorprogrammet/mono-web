import type { DepartmentJson, FieldOfStudyJson, TeamJson } from "@vektorprogrammet/domain";
import { apiUrl, createEffectClient } from "@vektorprogrammet/sdk/effect";
import type { Effect } from "effect";
import { resolveBrowserApiUrl } from "../../lib/browser-api";

export interface OrganizationCatalogOperations {
  readonly listDepartments: () => Effect.Effect<readonly DepartmentJson[], unknown>;
  readonly listTeams: () => Effect.Effect<readonly TeamJson[], unknown>;
  readonly listFieldOfStudies: () => Effect.Effect<readonly FieldOfStudyJson[], unknown>;
}

export interface OrganizationCatalogClient {
  readonly organization: OrganizationCatalogOperations;
}

export const createBrowserOrganizationCatalogClient = (): OrganizationCatalogClient => {
  const client = createEffectClient(resolveBrowserApiUrl(apiUrl, globalThis.location.origin));
  return {
    organization: client.organization,
  };
};
