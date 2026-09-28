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

export class NativeRpcs extends RpcGroup.make().merge(
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
).middleware(ProblemBoundary) {}

export class InternalNativeRpcs extends RpcGroup.make()
  .merge(InternalReceiptsRpcs)
  .middleware(ProblemBoundary) {}
