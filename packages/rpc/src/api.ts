/**
 * The native RPC contract: every operation a client of the native backend can call.
 *
 * Better Auth `/api/auth/*`, the OAuth2 routes, and `/health` stay plain HTTP: they are HTTP by
 * protocol or probed by infrastructure. Internal operations form their own group, which only the
 * internal ingress serves.
 *
 * @since 0.3.0
 */
import { RpcGroup } from "effect/unstable/rpc";
import { AdmissionOutcomesRpcs } from "./admission-outcomes.js";
import { ProblemBoundary } from "./boundary.js";
import { AdmissionsRpcs } from "./admissions.js";
import { CertificatesRpcs } from "./certificates.js";
import { ContactRpcs } from "./contact.js";
import { ContentRpcs } from "./content.js";
import { DirectoryRpcs } from "./directory.js";
import { OnboardingRpcs } from "./onboarding.js";
import { OrganizationRpcs } from "./organization.js";
import { PlacementsRpcs } from "./placements.js";
import { ProfileRpcs } from "./profile.js";
import { InternalReceiptsRpcs, ReceiptsRpcs } from "./receipts.js";
import { RecruitmentRpcs } from "./recruitment.js";
import { SocialEventsRpcs } from "./social-events.js";
import { SystemRpcs } from "./system.js";
import { TeamApplicationsRpcs } from "./team-application.js";

/** The path that serves `NativeRpcs` over HTTP. */
export const nativeRpcPath = "/api/rpc";

/** The path that serves `InternalNativeRpcs`, on the internal ingress only. */
export const internalNativeRpcPath = "/internal/rpc";

/**
 * Whether a request path addresses the native RPC endpoint.
 *
 * @remarks
 * The RPC client joins the endpoint URL with an empty request URL, so it posts to the path with one
 * trailing slash (`/api/rpc/`); a probe that builds its own request posts to `/api/rpc`. The
 * ingress serves both, and every recorder and filter asks this predicate, so no check matches one
 * spelling and silently misses the other.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * if (request.method === "POST" && isNativeRpcPath(new URL(request.url).pathname)) record(body);
 * ```
 *
 * @avoid `pathname === nativeRpcPath` or `pathname === "/api/rpc"`: every call of the RPC client
 * misses it. `anti-slop/no-rpc-path-comparison` rejects both.
 *
 * @param pathname - The path of a request URL, without its query.
 * @returns `true` for `/api/rpc` and `/api/rpc/`.
 *
 * @construct rpc-transport
 */
export const isNativeRpcPath = (pathname: string): boolean =>
  pathname === nativeRpcPath || pathname === `${nativeRpcPath}/`;

/**
 * Whether a request path addresses the internal RPC endpoint, as `isNativeRpcPath` does for the
 * external one.
 */
export const isInternalNativeRpcPath = (pathname: string): boolean =>
  pathname === internalNativeRpcPath || pathname === `${internalNativeRpcPath}/`;

export class NativeRpcs extends RpcGroup.make()
  .merge(
    AdmissionOutcomesRpcs,
    AdmissionsRpcs,
    CertificatesRpcs,
    ContactRpcs,
    ContentRpcs,
    DirectoryRpcs,
    OnboardingRpcs,
    OrganizationRpcs,
    PlacementsRpcs,
    ProfileRpcs,
    ReceiptsRpcs,
    RecruitmentRpcs,
    SocialEventsRpcs,
    SystemRpcs,
    TeamApplicationsRpcs,
  )
  .middleware(ProblemBoundary) {}

export class InternalNativeRpcs extends RpcGroup.make()
  .merge(InternalReceiptsRpcs)
  .middleware(ProblemBoundary) {}
