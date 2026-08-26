import type { AdmissionPeriodActor } from "@vektorprogrammet/domain/admission-period";
import {
  AdmissionScopeDenied,
  InactiveActor,
  UnauthenticatedActor,
} from "@vektorprogrammet/domain/admission-period";
import {
  Identity,
  IdentityEngineError,
  IdentityActor,
  IdentitySessionExpired,
  IdentitySessionNotFound,
} from "@vektorprogrammet/domain/identity";
import type {
  DepartmentId,
  OrganizationActor,
  OrganizationAuthorityInstant,
  OrganizationPersonAuthority,
  PersonId,
  ProfileRole,
} from "@vektorprogrammet/domain/organization";
import {
  mapOrganizationAuthorityToAdmissionPeriodActor,
  mapOrganizationAuthorityToOrganizationActor,
  mapOrganizationAuthorityToProfileRole,
  Organization,
  OrganizationAuthorityInstantSchema,
} from "@vektorprogrammet/domain/organization";
import type { Decision } from "@vektorprogrammet/domain/authz";
import type { RecruitmentActor } from "@vektorprogrammet/domain/recruitment";
import { Effect, Schema } from "effect";

/**
 * Flow: request Cookie -> Identity.resolveSession -> canonical PersonId +
 * one authorizationInstant -> Organization.resolvePersonAuthority -> request-
 * specific actor via the frozen 0055 mappers. Identity never contributes role
 * facts; the auth schema is not an input to any projection.
 */

import type {
  OrganizationDecodeError,
  OrganizationPersistenceError,
} from "@vektorprogrammet/domain/organization";

/** Projection failures are infrastructure-level and surface as typed denials upstream. */
export type OrganizationResolutionError = OrganizationDecodeError | OrganizationPersistenceError;

/** Injected clock keeps the one-instant-per-request law testable (spec 0055). */
const defaultNow = (): string => new Date().toISOString();

const decodeAuthorizationInstant = (value: string): OrganizationAuthorityInstant =>
  Schema.decodeUnknownSync(OrganizationAuthorityInstantSchema)(value);

const sessionEffect = (
  cookieHeader: string | undefined,
): Effect.Effect<IdentityActor, IdentityEngineError | UnauthenticatedActor, Identity> =>
  Identity.use(({ resolveSession }) =>
    Effect.tryPromise({
      try: () => resolveSession(cookieHeader),
      catch: (cause) => {
        if (cause instanceof IdentitySessionNotFound || cause instanceof IdentitySessionExpired) {
          return new UnauthenticatedActor({ message: "authentication required" });
        }
        return cause instanceof IdentityEngineError
          ? cause
          : new IdentityEngineError({
              operation: "resolveSession",
              message: cause instanceof Error ? cause.message : "identity provider failure",
            });
      },
    }),
  );

const personAuthorityEffect = (
  cookieHeader: string | undefined,
  instant: OrganizationAuthorityInstant,
): Effect.Effect<
  OrganizationPersonAuthority,
  IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError,
  Organization | Identity
> =>
  Effect.flatMap(sessionEffect(cookieHeader), (actor) =>
    Organization.use(({ resolvePersonAuthority }) =>
      resolvePersonAuthority(actor.personId, instant),
    ),
  );

export interface AuthorityResolutionOptions {
  readonly run: <A, E>(effect: Effect.Effect<A, E, Organization | Identity>) => Promise<A>;
  /** Injectable clock; defaults to the current ISO instant. */
  readonly now?: () => string;
}

/** Resolves the authenticated session while preserving infrastructure failures. */
export const resolveAuthenticatedSession = (
  cookieHeader: string | undefined,
  options: AuthorityResolutionOptions,
): Promise<IdentityActor> => options.run(sessionEffect(cookieHeader));

/** Cookie -> canonical PersonId only; for adapters that authenticate without roles. */
export const resolveAuthenticatedPerson = (
  cookieHeader: string | undefined,
  options: AuthorityResolutionOptions,
): Promise<PersonId> =>
  options.run(Effect.map(sessionEffect(cookieHeader), (actor) => actor.personId));

export interface AuthenticatedPersonAtInstant {
  readonly personId: PersonId;
  readonly authorizationInstant: OrganizationAuthorityInstant;
}

/**
 * Authenticates first, then captures exactly one instant for a caller-owned
 * read-only journey. Organization resolves its projection inside that journey.
 */
export const resolveAuthenticatedPersonAtInstant = (
  cookieHeader: string | undefined,
  options: AuthorityResolutionOptions,
): Promise<AuthenticatedPersonAtInstant> =>
  options.run(
    Effect.flatMap(sessionEffect(cookieHeader), (actor) =>
      Effect.sync(() => ({
        personId: actor.personId,
        authorizationInstant: decodeAuthorizationInstant((options.now ?? defaultNow)()),
      })),
    ),
  );

/** Captures ONE authorizationInstant per request and resolves the full projection. */
export const resolvePersonAuthority = (
  cookieHeader: string | undefined,
  options: AuthorityResolutionOptions,
): Promise<OrganizationPersonAuthority> => {
  const instant = decodeAuthorizationInstant((options.now ?? defaultNow)());
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
export const organizationActorFrom = (authority: OrganizationPersonAuthority): OrganizationActor =>
  mapOrganizationAuthorityToOrganizationActor(authority);

/** Coarse dashboard role from the full projection (spec 0055 §Profile).
 *  Returns the raw Decision so the adapter can translate Deny(reason) into its
 *  typed denial instead of an ambiguous collapse. */
export const profileRoleFrom = (authority: OrganizationPersonAuthority): Decision<ProfileRole> =>
  mapOrganizationAuthorityToProfileRole(authority);

/**
 * Board queries use ALL authorized departments (spec 0055 §Recruitment actor).
 * A person with active memberships in exactly one department reads that
 * department's board; a multi-department person must select a scope (the
 * request cannot invent one), so the ambiguity fails closed until canonical
 * request state carries a department selection.
 * Global administrators are NOT recruiters: the domain checkContext rejects
 * GlobalAdmin on recruitment routes, so no GlobalAdmin pass-through exists here.
 */
export const recruitmentBoardActorFrom = (
  authority: OrganizationPersonAuthority,
): RecruitmentActor => {
  const departments = [
    ...new Set(
      authority.memberships
        .filter((membership) => membership.active)
        .map((membership) => membership.departmentId),
    ),
  ].sort();
  if (departments.length === 1) {
    return admissionActorForDepartment(authority, departments[0]!);
  }
  throw new UnauthenticatedActor({
    message:
      departments.length === 0
        ? "no authorized recruitment department"
        : `recruitment board requires one department selection; authorized departments: ${departments.join(", ")}`,
  });
};
