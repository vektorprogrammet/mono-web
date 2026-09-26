import type { DepartmentJson,
FieldOfStudyJson,
TeamJson, } from "@vektorprogrammet/http-api"
import { createEffectClient, type EffectSdkFailure } from "@vektorprogrammet/sdk/effect";
import { Data, Effect } from "effect";
import { resolveBrowserApiUrl } from "../../lib/browser-api";

/** A catalog read that sent no cache validators was answered 304 Not Modified. */
export class OrganizationCatalogNotModified extends Data.TaggedError(
  "OrganizationCatalogNotModified",
)<{ readonly message: string }> {}

export interface OrganizationCatalogOperations {
  readonly listDepartments: Effect.Effect<
    readonly DepartmentJson[],
    EffectSdkFailure<"organization", "listDepartments"> | OrganizationCatalogNotModified
  >;
  readonly listTeams: Effect.Effect<
    readonly TeamJson[],
    EffectSdkFailure<"organization", "listTeams"> | OrganizationCatalogNotModified
  >;
  readonly listFieldOfStudies: Effect.Effect<
    readonly FieldOfStudyJson[],
    EffectSdkFailure<"organization", "listFieldOfStudies"> | OrganizationCatalogNotModified
  >;
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
      listDepartments: client.organization
        .listDepartments({ headers: {} })
        .pipe(
          Effect.flatMap(({ body }) =>
            body === undefined
              ? Effect.fail(
                  new OrganizationCatalogNotModified({
                    message: "listDepartments returned 304 without cache validators",
                  }),
                )
              : Effect.succeed(body),
          ),
        ),
      listTeams: client.organization
        .listTeams({ headers: {} })
        .pipe(
          Effect.flatMap(({ body }) =>
            body === undefined
              ? Effect.fail(
                  new OrganizationCatalogNotModified({
                    message: "listTeams returned 304 without cache validators",
                  }),
                )
              : Effect.succeed(body),
          ),
        ),
      listFieldOfStudies: client.organization
        .listFieldOfStudies({ headers: {} })
        .pipe(
          Effect.flatMap(({ body }) =>
            body === undefined
              ? Effect.fail(
                  new OrganizationCatalogNotModified({
                    message: "listFieldOfStudies returned 304 without cache validators",
                  }),
                )
              : Effect.succeed(body),
          ),
        ),
    },
  };
};
