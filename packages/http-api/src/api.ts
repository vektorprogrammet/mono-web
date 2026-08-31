/**
 * Composition of all Vektor-owned native HTTP groups.
 *
 * @since 0.1.0
 */
import { HttpApi, OpenApi } from "effect/unstable/httpapi";
import { AdmissionsApi } from "./admissions.js";
import { ContentApi } from "./content.js";
import { DirectoryApi } from "./directory.js";
import { OrganizationApi } from "./organization.js";
import { ProfileApi } from "./profile.js";
import { ReceiptsApi, InternalApi } from "./receipts.js";
import { RecruitmentApi } from "./recruitment.js";
import { RequestSchemaErrorMiddleware } from "./common.js";
import { SystemApi } from "./system.js";
/**
 * Complete Vektor-owned native HTTP contract.
 *
 * Better Auth `/api/auth/*` remains external. The internal group is executable
 * but excluded from the generated public OpenAPI projection.
 *
 * @since 0.1.0
 * @category APIs
 */
export class NativeApi extends HttpApi.make("native-api")
  .add(SystemApi)
  .add(ProfileApi)
  .add(OrganizationApi)
  .add(DirectoryApi)
  .add(AdmissionsApi)
  .add(RecruitmentApi)
  .add(ReceiptsApi)
  .add(ContentApi)
  .add(InternalApi)
  .middleware(RequestSchemaErrorMiddleware)
  .annotateMerge(
    OpenApi.annotations({
      title: "Vektorprogrammet native preview API",
      version: "0.1.0",
      description: "The complete Vektor-owned native backend contract for preview environments.",
      servers: [],
      override: {
        "x-vektorprogrammet-provenance": {
          contract: "@vektorprogrammet/http-api/NativeApi",
          generator: "effect/unstable/httpapi/OpenApi.fromApi",
          schemas: "Effect.Schema",
          statuses: "HttpApiSchema.status",
          security: "HttpApiMiddleware.security",
          exclusions: ["Better Auth /api/auth/*", "internal evidence group"],
        },
        "x-tagGroups": [
          { name: "Platform", tags: ["System", "Profile"] },
          { name: "Directories", tags: ["Organization", "Directories"] },
          { name: "Admissions", tags: ["Admissions"] },
          { name: "Recruitment", tags: ["Recruitment"] },
          { name: "Economy", tags: ["Receipts"] },
          { name: "Content", tags: ["Content and news"] },
        ],
      },
    }),
  ) {}
