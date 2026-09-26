import { IdentitySnapshot, OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { Database } from "@vektorprogrammet/database";
import {
  AdmissionPeriodActorSchema,
  AdmissionRoleDenied,
  AdmissionScopeDenied,
  InactiveActor,
  UnauthenticatedActor,
  type AdmissionPeriodActor,
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
  mapOrganizationAuthorityToDepartmentActor,
  mapOrganizationAuthorityToOrganizationActor,
  mapOrganizationAuthorityToProfileRole,
  Organization,
  OrganizationAuthorityInstantSchema,
} from "@vektorprogrammet/domain/organization";
import {
  AuthorizationInstant,
  CredentialEvidenceRef,
  type CredentialOutcome,
  type Decision,
  type OrganizationCapability,
} from "@vektorprogrammet/domain/authz";
import {
  RecruitmentInactiveActor,
  RecruitmentRoleDenied,
  type RecruitmentActor,
} from "@vektorprogrammet/domain/recruitment";
import { DateTime, Predicate, Effect, Schema } from "effect";
import { hasBetterAuthSessionCredential } from "./session-security.js";

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

/**
 * Injected clock keeps the one-instant-per-request law testable (spec 0055).
 * Without an override, the instant comes from the Clock service.
 */
export const currentInstant = (now: (() => string) | undefined): Effect.Effect<string> =>
  now === undefined ? Effect.map(DateTime.now, DateTime.formatIso) : Effect.sync(now);

const decodeAuthorizationInstant = (value: string): OrganizationAuthorityInstant =>
  Schema.decodeSync(OrganizationAuthorityInstantSchema)(value);

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

/**
 * Counts the credentials a request presents in its headers. A Better Auth session
 * cookie and an Authorization header count one each. A request presents one
 * credential at most: with two, it fails before either one is resolved, so no
 * principal is ever chosen between them, whether they name one Person or two.
 */
export const headerCredentialCount = (
  cookieHeader: string | null | undefined,
  authorization: string | null | undefined,
): number =>
  (hasBetterAuthSessionCredential(cookieHeader ?? null) ? 1 : 0) +
  (Predicate.isNotNullish(authorization) ? 1 : 0);

type AcceptedCredential = Extract<CredentialOutcome, { readonly _tag: "Accepted" }>;

const requestCredentialEffect = (
  request: Request,
  expected: "OAuthUserBearer" | "OAuthServiceBearer" | "Either",
): Effect.Effect<
  AcceptedCredential,
  IdentityEngineError | UnauthenticatedActor,
  Identity | OAuthCredentialAuthority
> => {
  const authorization = request.headers.get("authorization");
  const cookieHeader = request.headers.get("cookie");

  if (headerCredentialCount(cookieHeader, authorization) > 1) {
    return Effect.fail(new UnauthenticatedActor({ message: "authentication required" }));
  }

  if (authorization !== null) {
    return OAuthCredentialAuthority.use(({ resolve }) =>
      Effect.tryPromise({
        try: () => resolve(request, expected),
        catch: (cause) =>
          cause instanceof IdentityEngineError
            ? cause
            : new IdentityEngineError({
                operation: "resolveOAuthCredential",
                message: cause instanceof Error ? cause.message : "identity provider failure",
              }),
      }),
    ).pipe(
      Effect.flatMap((outcome) =>
        Predicate.isTagged(outcome, "Accepted")
          ? Effect.succeed(outcome)
          : Effect.fail(new UnauthenticatedActor({ message: "authentication required" })),
      ),
    );
  }

  return Effect.map(sessionEffect(cookieHeader ?? undefined), (actor) => ({
    _tag: "Accepted" as const,
    mechanism: { _tag: "BetterAuthCookie" as const },
    principal: { _tag: "Person" as const, personId: actor.personId },
    evidenceRef: CredentialEvidenceRef.make(`better-auth:session:${actor.sessionId}`),
  }));
};

const requestPersonEffect = (
  request: Request,
): Effect.Effect<
  PersonId,
  IdentityEngineError | UnauthenticatedActor,
  Identity | OAuthCredentialAuthority
> =>
  Effect.flatMap(requestCredentialEffect(request, "OAuthUserBearer"), (credential) =>
    Predicate.isTagged(credential.principal, "Person")
      ? Effect.succeed(credential.principal.personId)
      : Effect.fail(new UnauthenticatedActor({ message: "authentication required" })),
  );

const requestCredentialInTransactionEffect = (
  request: Request,
  expected: "OAuthUserBearer" | "OAuthServiceBearer" | "Either",
  authorizationInstant: AuthorizationInstant,
): Effect.Effect<
  AcceptedCredential,
  IdentityEngineError | UnauthenticatedActor,
  Database | IdentitySnapshot | OAuthCredentialAuthority
> => {
  const authorization = request.headers.get("authorization");
  const cookieHeader = request.headers.get("cookie");

  if (headerCredentialCount(cookieHeader, authorization) > 1) {
    return Effect.fail(new UnauthenticatedActor({ message: "authentication required" }));
  }

  if (authorization !== null) {
    return OAuthCredentialAuthority.use(({ resolveInTransaction }) =>
      resolveInTransaction(request, expected, new Date(authorizationInstant)),
    ).pipe(
      Effect.flatMap((outcome) =>
        Predicate.isTagged(outcome, "Accepted")
          ? Effect.succeed(outcome)
          : Effect.fail(new UnauthenticatedActor({ message: "authentication required" })),
      ),
    );
  }

  if (expected === "OAuthServiceBearer") {
    return Effect.fail(new UnauthenticatedActor({ message: "authentication required" }));
  }

  return IdentitySnapshot.use(({ resolveSession }) =>
    resolveSession(cookieHeader ?? undefined, authorizationInstant),
  ).pipe(
    Effect.map((actor) => ({
      _tag: "Accepted" as const,
      mechanism: { _tag: "BetterAuthCookie" as const },
      principal: { _tag: "Person" as const, personId: actor.personId },
      evidenceRef: CredentialEvidenceRef.make(`better-auth:session:${actor.sessionId}`),
    })),
    Effect.mapError((cause) =>
      cause instanceof IdentitySessionNotFound || cause instanceof IdentitySessionExpired
        ? new UnauthenticatedActor({ message: "authentication required" })
        : cause,
    ),
  );
};

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
  /** Injectable clock; defaults to the current ISO instant. */
  readonly now?: () => string;
}

export interface TransactionCredentialResolutionOptions {
  readonly now?: () => string;
}

export interface TransactionPersonAuthorityResolutionOptions {
  readonly now?: () => string;
}

/**
 * Resolves the session of a session-only operation. An Authorization header beside the
 * session cookie is a second credential, so the request fails without resolving either.
 */
export const resolveAuthenticatedSession = (
  cookieHeader: string | undefined,
  authorization: string | undefined,
): Effect.Effect<IdentityActor, IdentityEngineError | UnauthenticatedActor, Identity> =>
  headerCredentialCount(cookieHeader, authorization) > 1
    ? Effect.fail(new UnauthenticatedActor({ message: "authentication required" }))
    : sessionEffect(cookieHeader);

/** Cookie -> canonical PersonId only; for adapters that authenticate without roles. */
export const resolveAuthenticatedPerson = (
  cookieHeader: string | undefined,
): Effect.Effect<PersonId, IdentityEngineError | UnauthenticatedActor, Identity> =>
  Effect.map(sessionEffect(cookieHeader), (actor) => actor.personId);

/** Browser session or delegated OAuth user bearer -> canonical PersonId. */
export const resolveRequestPerson = (
  request: Request,
): Effect.Effect<
  PersonId,
  IdentityEngineError | UnauthenticatedActor,
  Identity | OAuthCredentialAuthority
> => requestPersonEffect(request);

export interface AuthenticatedPersonAtInstant {
  readonly personId: PersonId;
  readonly authorizationInstant: OrganizationAuthorityInstant;
}

export interface AuthenticatedCredentialAtInstant {
  readonly credential: AcceptedCredential;
  readonly authorizationInstant: AuthorizationInstant;
}

/** Resolves one accepted request credential and captures one authorization instant. */
export const resolveRequestCredentialAtInstant = (
  request: Request,
  expected: "OAuthUserBearer" | "OAuthServiceBearer" | "Either",
  options: AuthorityResolutionOptions = {},
): Effect.Effect<
  AuthenticatedCredentialAtInstant,
  IdentityEngineError | UnauthenticatedActor,
  Identity | OAuthCredentialAuthority
> =>
  Effect.flatMap(requestCredentialEffect(request, expected), (credential) =>
    Effect.map(currentInstant(options.now), (instant) => ({
      credential,
      authorizationInstant: AuthorizationInstant.make(instant),
    })),
  );

/**
 * Resolves the current cookie or delegated bearer state through the caller's
 * ambient database transaction, then returns that exact credential evidence
 * and authorization instant to the AccessSpec evaluator.
 */
export const resolveRequestCredentialInTransaction = (
  request: Request,
  expected: "OAuthUserBearer" | "OAuthServiceBearer" | "Either",
  options: TransactionCredentialResolutionOptions = {},
): Effect.Effect<
  AuthenticatedCredentialAtInstant,
  IdentityEngineError | UnauthenticatedActor,
  Database | IdentitySnapshot | OAuthCredentialAuthority
> => {
  return Effect.flatMap(
    Effect.map(currentInstant(options.now), AuthorizationInstant.make),
    (authorizationInstant) =>
      Effect.map(
        requestCredentialInTransactionEffect(request, expected, authorizationInstant),
        (credential) => ({ credential, authorizationInstant }),
      ),
  );
};

export interface TransactionPersonAuthority {
  readonly credential: AcceptedCredential;
  readonly authority: OrganizationPersonAuthority;
  readonly authorizationInstant: AuthorizationInstant;
}

/** Resolves one current Person credential and its organization projection at one instant. */
export const resolveRequestPersonAuthorityInTransaction = (
  request: Request,
  options: TransactionPersonAuthorityResolutionOptions = {},
): Effect.Effect<
  TransactionPersonAuthority,
  IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError,
  Database | Organization | IdentitySnapshot | OAuthCredentialAuthority
> =>
  Effect.gen(function* () {
    const authenticated = yield* resolveRequestCredentialInTransaction(
      request,
      "OAuthUserBearer",
      options,
    );

    if (!Predicate.isTagged(authenticated.credential.principal, "Person")) {
      return yield* Effect.fail(new UnauthenticatedActor({ message: "authentication required" }));
    }

    const personId = authenticated.credential.principal.personId;
    const organization = yield* Organization;

    const authority = yield* organization.resolvePersonAuthority(
      personId,
      decodeAuthorizationInstant(authenticated.authorizationInstant),
    );

    return { ...authenticated, authority };
  });

/**
 * Authenticates first, then captures exactly one instant for a caller-owned
 * read-only journey. Organization resolves its projection inside that journey.
 */
export const resolveAuthenticatedPersonAtInstant = (
  cookieHeader: string | undefined,
  options: AuthorityResolutionOptions = {},
): Effect.Effect<
  AuthenticatedPersonAtInstant,
  IdentityEngineError | UnauthenticatedActor,
  Identity
> =>
  Effect.flatMap(sessionEffect(cookieHeader), (actor) =>
    Effect.map(currentInstant(options.now), (instant) => ({
      personId: actor.personId,
      authorizationInstant: decodeAuthorizationInstant(instant),
    })),
  );

/** Authenticates either person mechanism before capturing one authorization instant. */
export const resolveRequestPersonAtInstant = (
  request: Request,
  options: AuthorityResolutionOptions = {},
): Effect.Effect<
  AuthenticatedPersonAtInstant,
  IdentityEngineError | UnauthenticatedActor,
  Identity | OAuthCredentialAuthority
> =>
  Effect.flatMap(requestPersonEffect(request), (personId) =>
    Effect.map(currentInstant(options.now), (instant) => ({
      personId,
      authorizationInstant: decodeAuthorizationInstant(instant),
    })),
  );

/** Captures ONE authorizationInstant per request and resolves the full projection. */
export const resolvePersonAuthority = (
  cookieHeader: string | undefined,
  options: AuthorityResolutionOptions = {},
): Effect.Effect<
  OrganizationPersonAuthority,
  IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError,
  Organization | Identity
> => {
  return Effect.flatMap(
    Effect.map(currentInstant(options.now), decodeAuthorizationInstant),
    (instant) => personAuthorityEffect(cookieHeader, instant),
  );
};

/** Resolves Identity first, then captures one authorization instant for a request. */
export const resolvePersonAuthorityAfterSession = (
  cookieHeader: string | undefined,
  options: AuthorityResolutionOptions = {},
): Effect.Effect<
  OrganizationPersonAuthority,
  IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError,
  Organization | Identity
> =>
  Effect.flatMap(sessionEffect(cookieHeader), (actor) =>
    Effect.flatMap(Effect.map(currentInstant(options.now), decodeAuthorizationInstant), (instant) =>
      Organization.use(({ resolvePersonAuthority }) =>
        resolvePersonAuthority(actor.personId, instant),
      ),
    ),
  );

/** Resolves either person credential into the same current organization authority. */
export const resolveRequestPersonAuthority = (
  request: Request,
  options: AuthorityResolutionOptions = {},
): Effect.Effect<
  OrganizationPersonAuthority,
  IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError,
  Organization | Identity | OAuthCredentialAuthority
> =>
  Effect.flatMap(requestPersonEffect(request), (personId) =>
    Effect.flatMap(Effect.map(currentInstant(options.now), decodeAuthorizationInstant), (instant) =>
      Organization.use(({ resolvePersonAuthority }) => resolvePersonAuthority(personId, instant)),
    ),
  );

/**
 * Maps the projection onto the actor of one department scope for one capability.
 * Denials become typed 403-family errors (AuthorityInactive / NotInScope).
 */
const departmentActorFor = (
  authority: OrganizationPersonAuthority,
  capability: OrganizationCapability,
  departmentId: DepartmentId,
): AdmissionPeriodActor => {
  const decision = mapOrganizationAuthorityToDepartmentActor(authority, capability, departmentId);

  if (Predicate.isTagged(decision, "Deny")) {
    throw decision.reason === "AuthorityInactive"
      ? new InactiveActor({ personId: authority.personId })
      : new AdmissionScopeDenied({ personId: authority.personId, departmentId });
  }

  return decision.value;
};

/** The admission-period actor of one department scope. */
export const admissionActorForDepartment = (
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId,
): AdmissionPeriodActor => departmentActorFor(authority, "admissions.periods", departmentId);

/** Active global administrator maps to OrganizationAdministrator; everyone else Member. */
export const organizationActorFrom = (authority: OrganizationPersonAuthority): OrganizationActor =>
  mapOrganizationAuthorityToOrganizationActor(authority);

/** Coarse dashboard role from the full projection (spec 0055 §Profile).
 *  Returns the raw Decision so the adapter can translate Deny(reason) into its
 *  typed denial instead of an ambiguous collapse. */
export const profileRoleFrom = (authority: OrganizationPersonAuthority): Decision<ProfileRole> =>
  mapOrganizationAuthorityToProfileRole(authority);

/** Departments in which the person holds an active membership, in a stable order. */
const activeDepartments = (authority: OrganizationPersonAuthority): ReadonlyArray<DepartmentId> =>
  [
    ...new Set(
      authority.memberships
        .filter((membership) => membership.active)
        .map((membership) => membership.departmentId),
    ),
  ].sort();

/**
 * Actor of an admission route that names no department. An active global administrator acts
 * globally; anyone else acts in the single department of their active memberships, also after a
 * global-administrator grant has ended. A person without exactly one such department is
 * authenticated but not authorized: a 401 would tell the dashboard that the session expired and
 * sign the person out.
 */
export const unscopedAdmissionActorFrom = (
  authority: OrganizationPersonAuthority,
): AdmissionPeriodActor => {
  if (authority.globalAdministrator === "Active") {
    return AdmissionPeriodActorSchema.cases.GlobalAdmin.make({
      personId: authority.personId,
      active: true,
    });
  }

  const departments = activeDepartments(authority);

  if (departments.length === 1) return admissionActorForDepartment(authority, departments[0]!);

  throw departments.length === 0 &&
    (authority.memberships.length > 0 || authority.globalAdministrator === "Inactive")
    ? new InactiveActor({ personId: authority.personId })
    : new AdmissionRoleDenied({ personId: authority.personId });
};

/**
 * Board queries use ALL authorized departments (spec 0055 §Recruitment actor).
 * A person with active memberships in exactly one department reads that
 * department's board; a multi-department person must select a scope (the
 * request cannot invent one), so the ambiguity fails closed until canonical
 * request state carries a department selection.
 * Global administrators are NOT recruiters: the domain checkContext rejects
 * GlobalAdmin on recruitment routes, so no GlobalAdmin pass-through exists here.
 * Every refusal is an authorization denial, because the person is authenticated.
 */
export const recruitmentBoardActorFrom = (
  authority: OrganizationPersonAuthority,
): RecruitmentActor => {
  const departments = activeDepartments(authority);

  if (departments.length === 1) {
    return departmentActorFor(authority, "recruitment.interviews", departments[0]!);
  }

  throw departments.length === 0 && authority.memberships.length > 0
    ? new RecruitmentInactiveActor({ personId: authority.personId })
    : new RecruitmentRoleDenied({ personId: authority.personId });
};
