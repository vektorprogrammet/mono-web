import type { AdmissionPeriodActor } from "@vektorprogrammet/domain/admission-period";
import {
  AdmissionScopeDenied,
  InactiveActor,
  UnauthenticatedActor,
} from "@vektorprogrammet/domain/admission-period";
import { Auth, AuthenticatedActor } from "@vektorprogrammet/domain/auth";
import type {
  DepartmentId,
  OrganizationActor,
  OrganizationPersonAuthority,
  PersonId,
  ProfileRole,
} from "@vektorprogrammet/domain/organization";
import {
  mapOrganizationAuthorityToAdmissionPeriodActor,
  mapOrganizationAuthorityToOrganizationActor,
  mapOrganizationAuthorityToProfileRole,
  Organization,
} from "@vektorprogrammet/domain/organization";
import type { Decision } from "@vektorprogrammet/domain/authz";
import type { RecruitmentActor } from "@vektorprogrammet/domain/recruitment";
import { Effect } from "effect";

/**
 * Person-keyed authority resolution (spec 0055) for the backend HTTP adapters.
 *
 * Flow: request Cookie -> Auth.resolveSession -> PersonId + one
 * authorizationInstant -> Organization.resolvePersonAuthority -> request-
 * specific actor via the frozen 0055 mappers. Identity never contributes role
 * facts; the auth schema is not an input to any projection.
 */

import type {
  OrganizationDecodeError,
  OrganizationPersistenceError,
} from "@vektorprogrammet/domain/organization";

/** Projection failures are infrastructure-level and surface as typed denials upstream. */
export type OrganizationResolutionError =
  | OrganizationDecodeError
  | OrganizationPersistenceError;

/** Injected clock keeps the one-instant-per-request law testable (spec 0055). */
const defaultNow = (): string => new Date().toISOString();

const sessionEffect = (
  cookieHeader: string | undefined,
): Effect.Effect<AuthenticatedActor, UnauthenticatedActor, Auth> =>
  Auth.use(({ resolveSession }) =>
    Effect.tryPromise({
      try: () => resolveSession(cookieHeader),
      catch: () => new UnauthenticatedActor({ message: "authentication required" }),
    }),
  );

const personAuthorityEffect = (
  cookieHeader: string | undefined,
  instant: string,
): Effect.Effect<
  OrganizationPersonAuthority,
  UnauthenticatedActor | OrganizationResolutionError,
  Organization | Auth
> =>
  Effect.flatMap(sessionEffect(cookieHeader), (actor) =>
    Organization.use(({ resolvePersonAuthority }) =>
      resolvePersonAuthority(actor.personId as unknown as PersonId, instant as never),
    ),
  );

export interface AuthorityResolutionOptions {
  readonly run: <A, E>(effect: Effect.Effect<A, E, Organization | Auth>) => Promise<A>;
  /** Injectable clock; defaults to the current ISO instant. */
  readonly now?: () => string;
}

/** Cookie -> PersonId only; for adapters that authenticate without roles. */
export const resolveAuthenticatedPerson = (
  cookieHeader: string | undefined,
  options: AuthorityResolutionOptions,
): Promise<PersonId> =>
  options.run(
    Effect.map(sessionEffect(cookieHeader), (actor) => actor.personId as unknown as PersonId),
  );

/** Captures ONE authorizationInstant per request and resolves the full projection. */
export const resolvePersonAuthority = (
  cookieHeader: string | undefined,
  options: AuthorityResolutionOptions,
): Promise<OrganizationPersonAuthority> => {
  const instant = (options.now ?? defaultNow)();
  return options.run(personAuthorityEffect(cookieHeader, instant));
};

/**
 * Maps the projection onto the admission actor for one department scope.
 * Denials become typed 403-family errors (AuthorityInactive / NotInScope).
 */
export const admissionActorForDepartment = (
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId,
): AdmissionPeriodActor => {
  const decision = mapOrganizationAuthorityToAdmissionPeriodActor(authority, departmentId);
  if (decision._tag === "Deny") {
    throw decision.reason === "AuthorityInactive"
      ? new InactiveActor({ personId: authority.personId })
      : new AdmissionScopeDenied({ personId: authority.personId, departmentId });
  }
  return decision.value;
};

/** Recruitment shares the admission department-scoped mapping (spec 0055). */
export const recruitmentActorForDepartment = (
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId,
): RecruitmentActor => admissionActorForDepartment(authority, departmentId);

/** Active global administrator maps to OrganizationAdministrator; everyone else Member. */
export const organizationActorFrom = (
  authority: OrganizationPersonAuthority,
): OrganizationActor => mapOrganizationAuthorityToOrganizationActor(authority);

/** Coarse dashboard role from the full projection (spec 0055 §Profile).
 *  Returns the raw Decision so the adapter can translate Deny(reason) into its
 *  typed denial instead of an ambiguous collapse. */
export const profileRoleFrom = (
  authority: OrganizationPersonAuthority,
): Decision<ProfileRole> => mapOrganizationAuthorityToProfileRole(authority);
