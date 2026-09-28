/**
 * The OnboardingRpcs handlers. A coordinator, who holds `admissions.outcomes` in the department,
 * reads the department's onboarding board and invites or revokes, with the authority resolved in
 * the transaction that reads or commits. A command stores its answer as a command receipt, so a
 * retry with the same idempotency key replays it. A claim is authorized by its token: in
 * new-account mode the token is the one credential, in existing-account mode the browser session
 * names the Person and the token is its requirement.
 */
import {
  Database,
  hashOnboardingPassword,
  provisionOnboardingAccount,
} from "@vektorprogrammet/database";
import {
  checkOnboardingClaim,
  claimOnboarding,
  commandOnboarding,
  lockOnboardingApplicant,
  onboardingApplication,
  readOnboardingBoard,
} from "@vektorprogrammet/database/onboarding";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  credentialMatchesAccessSpec,
  requireDepartmentReach,
  Scope,
} from "@vektorprogrammet/domain/authz";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import {
  OnboardingCommand,
  OnboardingClaim,
  type OnboardingFailure,
} from "@vektorprogrammet/domain/onboarding";
import {
  type DepartmentId,
  type OrganizationDecodeError,
  type OrganizationPersistenceError,
  PersonId,
} from "@vektorprogrammet/domain/organization";
import {
  ClaimOnboarding,
  CommandOnboarding,
  OnboardingResource,
  OnboardingRpcs,
  ReadOnboardingBoard,
  reflectAccessSpec,
} from "@vektorprogrammet/rpc";
import {
  type CredentialPresentation,
  type IdempotencyKey,
  nativeCookieChallenge,
  Problem,
  type StrongETag,
} from "@vektorprogrammet/rpc/problem";
import { Crypto, Effect, Option, Predicate, Schema } from "effect";
import type { Headers } from "effect/unstable/http";
import type { Rpc } from "effect/unstable/rpc";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  currentInstant,
  headerCredentialCount,
  resolveRequestPersonAuthorityInTransaction,
} from "../authority.js";
import {
  deriveStrongETag,
  jsonBodyBytes,
  normalizeTarget,
  semanticMutationRequest,
  semanticRequestDigest,
} from "../http-semantics.js";
import { genericContext } from "../native-operation.js";
import { credentialRequestOf } from "../rpc/credential.js";
import type { NativeRpcOptions } from "../rpc/options.js";
import {
  authorizePerson,
  commandIdentity,
  commandOutcome,
  commandReceiptProblems,
  isSerializationConflict,
  jsonText,
  personPresentation,
  problemMapper,
  requireCurrentETag,
} from "../rpc/problem.js";
import {
  executeNativeHttpCommandPostgres,
  type NativeHttpResponseCapsule,
} from "../rpc/receipt-transaction.js";
import { drainOnboardingDelivery } from "./delivery.js";

/** The SQLSTATE of the first coded failure in a cause chain. */
const sqlState = (cause: unknown, depth = 0): string | undefined => {
  if (depth >= 8 || !Predicate.isObjectOrArray(cause)) return undefined;

  if (Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code)) return cause.code;

  return Predicate.hasProperty(cause, "cause") ? sqlState(cause.cause, depth + 1) : undefined;
};

/**
 * A failed statement. A unique violation means a racing claim provisioned the same account first,
 * so the claimant must sign in to it.
 */
const sqlProblem = (cause: SqlError | OrganizationPersistenceError) =>
  sqlState(cause) === "23505"
    ? Problem.make("onboarding.sign-in-required")
    : isSerializationConflict(cause)
      ? Problem.make("transaction.conflict")
      : Problem.make("internal.error");

/**
 * The one answer for every onboarding failure. A person credential rejected inside the
 * transaction is answered from the request's own evidence.
 */
const onboardingProblems = (presentation: CredentialPresentation) =>
  problemMapper<
    | OnboardingFailure
    | UnauthenticatedActor
    | IdentityEngineError
    | OrganizationDecodeError
    | OrganizationPersistenceError
    | SqlError
  >()({
    OnboardingFailure: ({ code }) => Problem.make(code),
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    IdentityEngineError: () => Problem.make("internal.error"),
    OrganizationDecodeError: () => Problem.make("internal.error"),
    OrganizationPersistenceError: sqlProblem,
    SqlError: sqlProblem,
  });

/** Hex SHA-256 of a claim token, the only form the database stores. */
const tokenDigest = (token: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).pipe(
    Effect.map((digest) => Buffer.from(digest).toString("hex")),
  );

/**
 * The board beside its entity tag, which covers the whole board: any change to it changes the tag.
 * Board rows reach the schema unchecked, so a row outside it is a defect, not a request error.
 */
const boardResource = (board: {
  readonly departmentId: DepartmentId;
  readonly items: ReadonlyArray<unknown>;
}) =>
  Effect.gen(function* () {
    const text = yield* jsonText(board);

    return yield* Schema.decodeUnknownEffect(OnboardingResource)(
      {
        ...board,
        etag: deriveStrongETag({
          representationKind: "OnboardingSnapshot",
          resourceIdentity: text,
          version: text,
        }),
      },
      { onExcessProperty: "error" },
    ).pipe(Effect.orDie);
  });

/**
 * The receipt of an onboarding command, byte for byte what the HTTP contract stored: the resource
 * as JSON, and its entity tag as the `etag` header.
 */
const resourceCapsule = (resource: OnboardingResource) =>
  Schema.encodeEffect(Schema.toCodecJson(OnboardingResource))(resource).pipe(
    Effect.orDie,
    Effect.map(
      (body): NativeHttpResponseCapsule => ({
        status: 200,
        mediaType: "application/json",
        headers: { "content-type": "application/json", etag: resource.etag },
        bodyBytes: jsonBodyBytes(body),
      }),
    ),
  );

/**
 * Whoever holds `admissions.outcomes` in the department invites admitted applicants, then the
 * declared AccessSpec, at one transaction instant. The reach is the command's evidence.
 */
const authorize = (input: {
  readonly headers: Headers.Headers;
  readonly rpc: Pick<Rpc.AnyWithProps, "annotations">;
  readonly departmentId: DepartmentId;
  readonly now: (() => string) | undefined;
}) =>
  Effect.gen(function* () {
    const auth = yield* resolveRequestPersonAuthorityInTransaction(
      credentialRequestOf(input.headers),
      { now: input.now },
    );

    const coordinator = yield* Effect.fromResult(
      requireDepartmentReach(auth.authority, "admissions.outcomes", input.departmentId),
    ).pipe(Effect.mapError(() => Problem.make("authority.denied")));

    yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(input.rpc)),
        credential: auth.credential,
        personId: auth.authority.personId,
        resolution: {
          selection: "ExactlyOne",
          contexts: [
            genericContext({
              domainId: "organization",
              departmentId: input.departmentId,
              authorityVersion: auth.authorizationInstant,
            }),
          ],
        },
        grantScopes: [Scope.Department({ departmentId: input.departmentId })],
        now: auth.authorizationInstant,
      },
      personPresentation(input.headers),
    );

    return { ...auth, coordinator };
  });

/**
 * The one principal of an existing-account claim: a Person credential that the claim's AccessSpec
 * accepts. The AccessSpec accepts the browser session and no bearer. The token is checked and
 * consumed afterwards, by claimOnboarding.
 */
const claimingPerson = (headers: Headers.Headers, now: (() => string) | undefined) =>
  Effect.gen(function* () {
    const auth = yield* resolveRequestPersonAuthorityInTransaction(credentialRequestOf(headers), {
      now,
    });

    if (
      !credentialMatchesAccessSpec(
        Option.getOrThrow(reflectAccessSpec(ClaimOnboarding)),
        auth.credential,
      )
    )
      return yield* UnauthenticatedActor.make({ message: "authentication required" });

    return auth.authority.personId;
  });

const OnboardingCommandJson = Schema.toCodecJson(OnboardingCommand);

const readBoard = (
  headers: Headers.Headers,
  departmentId: DepartmentId,
  options: NativeRpcOptions,
) =>
  Database.use((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* authorize({ headers, rpc: ReadOnboardingBoard, departmentId, now: options.now });

        return yield* boardResource(yield* readOnboardingBoard(departmentId));
      }),
    ),
  ).pipe(onboardingProblems(personPresentation(headers)));

const command = (
  headers: Headers.Headers,
  payload: {
    readonly departmentId: DepartmentId;
    readonly idempotencyKey: IdempotencyKey;
    readonly ifMatch: StrongETag;
    readonly request: OnboardingCommand;
  },
  options: NativeRpcOptions,
) =>
  Effect.gen(function* () {
    const { departmentId, idempotencyKey, ifMatch, request: selected } = payload;
    const presentation = personPresentation(headers);

    // The HTTP contract digested the command's JSON body.
    const body = yield* Schema.encodeEffect(OnboardingCommandJson)(selected).pipe(Effect.orDie);

    // The HTTP route of the department stays the normalized target, so receipts are stable.
    const normalizedTarget = yield* Effect.sync(() =>
      normalizeTarget("/api/onboarding/{departmentId}", { departmentId }),
    );

    const token =
      "onboard_" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

    const digest = yield* tokenDigest(token);

    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const auth = yield* authorize({
          headers,
          rpc: CommandOnboarding,
          departmentId,
          now: options.now,
        });

        const identity = yield* commandIdentity({
          credentialSubject: `Person:${auth.authority.personId}`,
          qualifiedOperationId: "onboarding.command",
          normalizedTarget,
          idempotencyKey,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest(semanticMutationRequest(body, ifMatch)),
            operationId: "onboarding.command",
          },
          execute: Effect.gen(function* () {
            const app = yield* onboardingApplication(selected.applicationId, departmentId);
            yield* lockOnboardingApplicant(app.applicantId);
            const current = yield* boardResource(yield* readOnboardingBoard(departmentId));
            yield* requireCurrentETag(current.etag, ifMatch);
            yield* commandOnboarding({
              coordinator: auth.coordinator,
              command: selected,
              now: auth.authorizationInstant,
              invitationId: "onboarding-" + identity.identitySha256,
              token,
              digest,
            });

            const changed = yield* boardResource(yield* readOnboardingBoard(departmentId));

            return yield* resourceCapsule(changed);
          }),
        };
      }),
    ).pipe(onboardingProblems(presentation), commandReceiptProblems);

    const resource = yield* commandOutcome(OnboardingResource)(outcome);

    if (selected.action !== "Revoke")
      yield* drainOnboardingDelivery(selected.applicationId, options.config.onboarding).pipe(
        Effect.catchTag("SchemaError", Effect.die),
        onboardingProblems(presentation),
      );

    return resource;
  });

// The session is the claim's one Person credential, so a credential problem challenges for it.
const claim = (
  headers: Headers.Headers,
  payload: typeof OnboardingClaim.Type,
  options: NativeRpcOptions,
) =>
  Effect.gen(function* () {
    const now = currentInstant(options.now);
    const digest = yield* tokenDigest(payload.token);

    // A new-account claim presents one credential: its token. An existing-account claim has one
    // principal, the browser session's Person. Its token is then a single-use requirement bound to
    // one invitation, which claimOnboarding checks and consumes after the Person is resolved.
    if (payload.mode === "NewAccount") {
      if (headerCredentialCount(headers.cookie, headers.authorization) > 0)
        return yield* UnauthenticatedActor.make({ message: "authentication required" });

      yield* checkOnboardingClaim(digest, yield* now);
    }

    const newAccount =
      payload.mode === "NewAccount"
        ? {
            mode: "NewAccount" as const,
            personId: PersonId.make(
              yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4).pipe(Effect.orDie),
            ),
            passwordHash: yield* hashOnboardingPassword(payload.password).pipe(Effect.orDie),
          }
        : null;

    return yield* Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const identity = newAccount ?? {
            mode: "ExistingAccount" as const,
            personId: yield* claimingPerson(headers, options.now),
          };

          return yield* claimOnboarding({
            digest,
            now: yield* now,
            identity,
            provision: provisionOnboardingAccount,
          });
        }),
      ),
    );
  }).pipe(onboardingProblems(personPresentation(headers, nativeCookieChallenge)));

/** The OnboardingRpcs handlers. */
export const OnboardingRpcHandlers = (options: NativeRpcOptions) =>
  OnboardingRpcs.toLayer({
    "onboarding.readBoard": ({ departmentId }, { headers }) =>
      readBoard(headers, departmentId, options),
    "onboarding.command": (payload, { headers }) => command(headers, payload, options),
    "onboarding.claim": (payload, { headers }) => claim(headers, payload, options),
  });
