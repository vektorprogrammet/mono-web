import type { DepartmentJson, FieldOfStudyJson, TeamJson } from "@vektorprogrammet/domain";
import { createEffectClient } from "@vektorprogrammet/sdk/effect";
import { Effect } from "effect";
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
  const client = createEffectClient(
    resolveBrowserApiUrl(import.meta.env.VITE_API_URL, globalThis.location.origin),
  );
  return {
    organization: {
      listDepartments: () =>
        client.organization
          .listDepartments({ headers: {} })
          .pipe(
            Effect.flatMap(({ body }) =>
              body === undefined
                ? Effect.fail(new Error("listDepartments returned 304 without cache validators"))
                : Effect.succeed(body),
            ),
          ),
      listTeams: () =>
        client.organization
          .listTeams({ headers: {} })
          .pipe(
            Effect.flatMap(({ body }) =>
              body === undefined
                ? Effect.fail(new Error("listTeams returned 304 without cache validators"))
                : Effect.succeed(body),
            ),
          ),
      listFieldOfStudies: () =>
        client.organization
          .listFieldOfStudies({ headers: {} })
          .pipe(
            Effect.flatMap(({ body }) =>
              body === undefined
                ? Effect.fail(new Error("listFieldOfStudies returned 304 without cache validators"))
                : Effect.succeed(body),
            ),
          ),
    },
  };
};
