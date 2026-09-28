/** Admission authorization helpers shared by the read and command handlers. */
import type {
  Database,
  IdentitySnapshot,
  OAuthCredentialAuthority,
} from "@vektorprogrammet/database";
import type {
  AdmissionPeriodActor,
  UnauthenticatedActor,
} from "@vektorprogrammet/domain/admission-period";
import { ResourceId, ResourceKind, Scope } from "@vektorprogrammet/domain/authz";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type { Organization } from "@vektorprogrammet/domain/organization";
import {
  ReadReturningAssistantOptions,
  RegisterReturningAssistant,
  reflectAccessSpec,
} from "@vektorprogrammet/rpc";
import type { Problem } from "@vektorprogrammet/rpc/problem";
import { Effect, Option, Predicate } from "effect";
import type { Headers } from "effect/unstable/http";
import {
  type OrganizationResolutionError,
  resolveRequestPersonAuthorityInTransaction,
  type TransactionPersonAuthority,
} from "../authority.js";
import { genericContext, type NativePersonAuthorization } from "../native-operation.js";
import { credentialRequestOf } from "../rpc/credential.js";
import type { NativeRpcOptions } from "../rpc/options.js";
import { authorizePerson, personPresentation, unreachable } from "../rpc/problem.js";
import { dual } from "effect/Function";

export const admissionGrantScopes = (actor: AdmissionPeriodActor) =>
  Predicate.isTagged(actor, "GlobalAdmin")
    ? ([Scope.Global()] as const)
    : Predicate.isTagged(actor, "DepartmentAdministrator")
      ? ([Scope.Department({ departmentId: actor.departmentId })] as const)
      : [];

export const returningPersonResource = (personId: string) =>
  Scope.Resource({
    resource: {
      kind: ResourceKind.make("person-profile"),
      id: ResourceId.make(personId),
    },
  });

/**
 * Evaluates one admission person AccessSpec.
 *
 * @remarks
 * It runs `authorizePerson` with the credential headers that the request presented, then
 * `unreachable("resource.not-found")`: every admission AccessSpec reveals its denials, so
 * authorization never answers resource.not-found, and a concealment would be a defect.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * yield* authorizeAdmissionPerson(headers, { spec, credential, personId, resolution, grantScopes, now });
 * ```
 *
 * @avoid Calling `authorizePerson` in an admission handler and declaring resource.not-found on the
 * RPC: admission specs reveal their denials, so that problem never occurs. Call this.
 *
 * @construct rpc-problem
 */
export const authorizeAdmissionPerson: {
  (
    input: NativePersonAuthorization,
  ): (
    headers: Headers.Headers,
  ) => Effect.Effect<
    void,
    Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">
  >;
  (
    headers: Headers.Headers,
    input: NativePersonAuthorization,
  ): Effect.Effect<
    void,
    Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">
  >;
} = dual(
  2,
  (
    headers: Headers.Headers,
    input: NativePersonAuthorization,
  ): Effect.Effect<
    void,
    Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">
  > => authorizePerson(input, personPresentation(headers)).pipe(unreachable("resource.not-found")),
);

/**
 * Resolves the current person and authorizes one returning-assistant operation on that person's
 * own profile.
 *
 * @remarks
 * It resolves the request's person credential and organization authority in the caller's
 * transaction at one instant, then evaluates the RPC's AccessSpec for that person over their own
 * `person-profile` resource, with the resource as the grant scope. It answers the resolved
 * authority, whose instant the command uses for its own reads.
 *
 * @sideEffects Reads the person's session or token and organization authority in the caller's
 * transaction.
 *
 * @example
 * ```ts
 * const authorization = yield* returningAuthorization(headers, options, RegisterReturningAssistant);
 * ```
 *
 * @avoid Authorizing a returning-assistant operation with the actor of an admission period: the
 * operation acts on the person's own profile, not on a department. Resolve it with this.
 *
 * @construct rpc-problem
 */
export const returningAuthorization: {
  (
    options: NativeRpcOptions,
    rpc: typeof ReadReturningAssistantOptions | typeof RegisterReturningAssistant,
  ): (
    headers: Headers.Headers,
  ) => Effect.Effect<
    TransactionPersonAuthority,
    | IdentityEngineError
    | UnauthenticatedActor
    | OrganizationResolutionError
    | Problem<"authority.denied">
    | Problem<"credential.invalid">
    | Problem<"credential.missing">,
    Database | Organization | IdentitySnapshot | OAuthCredentialAuthority
  >;
  (
    headers: Headers.Headers,
    options: NativeRpcOptions,
    rpc: typeof ReadReturningAssistantOptions | typeof RegisterReturningAssistant,
  ): Effect.Effect<
    TransactionPersonAuthority,
    | IdentityEngineError
    | UnauthenticatedActor
    | OrganizationResolutionError
    | Problem<"authority.denied">
    | Problem<"credential.invalid">
    | Problem<"credential.missing">,
    Database | Organization | IdentitySnapshot | OAuthCredentialAuthority
  >;
} = dual(
  3,
  (
    headers: Headers.Headers,
    options: NativeRpcOptions,
    rpc: typeof ReadReturningAssistantOptions | typeof RegisterReturningAssistant,
  ): Effect.Effect<
    TransactionPersonAuthority,
    | IdentityEngineError
    | UnauthenticatedActor
    | OrganizationResolutionError
    | Problem<"authority.denied">
    | Problem<"credential.invalid">
    | Problem<"credential.missing">,
    Database | Organization | IdentitySnapshot | OAuthCredentialAuthority
  > =>
    Effect.gen(function* () {
      const authorization = yield* resolveRequestPersonAuthorityInTransaction(
        credentialRequestOf(headers),
        { now: options.config.admission.now },
      );

      yield* authorizeAdmissionPerson(headers, {
        spec: Option.getOrThrow(reflectAccessSpec(rpc)),
        credential: authorization.credential,
        personId: authorization.authority.personId,
        resolution: {
          selection: "ExactlyOne",
          contexts: [
            genericContext({
              domainId: "admissions",
              resourceKind: "person-profile",
              resourceId: authorization.authority.personId,
              facts: { ownerPersonId: authorization.authority.personId },
              authorityVersion: "admissions:returning-assistant",
            }),
          ],
        },
        grantScopes: [returningPersonResource(authorization.authority.personId)],
        now: authorization.authorizationInstant,
      });

      return authorization;
    }),
);
