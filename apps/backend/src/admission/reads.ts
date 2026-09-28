/** Admission read handlers: admission periods, public applications, and returning assistants. */
import { Database } from "@vektorprogrammet/database";
import { Admissions } from "@vektorprogrammet/domain/admissions";
import {
  ApplicantProgressResponseSchema,
  ReturningAssistantOptionsSchema,
  ReturningAssistants,
  type PublicApplicationId,
} from "@vektorprogrammet/domain/application";
import {
  AdmissionPeriodManagementListResponse,
  ListAdmissionPeriods,
  ListApplicationOptions,
  ListOpenAdmissionPeriods,
  OpenAdmissionPeriodListResponse,
  PublicApplicationCatalogSchema,
  PublicApplicationConfirmationSchema,
  ReadApplicantProgress,
  ReadApplicationConfirmation,
  ReadReturningAssistantOptions,
  reflectAccessSpec,
} from "@vektorprogrammet/rpc";
import { Problem } from "@vektorprogrammet/rpc/problem";
import { Effect, Option, Predicate } from "effect";
import type { Headers } from "effect/unstable/http";
import {
  currentInstant,
  resolveRequestPersonAuthority,
  resolveRequestPersonAuthorityInTransaction,
} from "../authority.js";
import { deriveStrongETag } from "../http-semantics.js";
import { genericContext } from "../native-operation.js";
import { credentialRequestOf } from "../rpc/credential.js";
import type { NativeRpcOptions } from "../rpc/options.js";
import { authorizeAnonymous, strictOutput, unreachable } from "../rpc/problem.js";
import {
  admissionGrantScopes,
  authorizeAdmissionPerson,
  returningAuthorization,
  returningPersonResource,
} from "./access.js";
import { admissionActorForAuthority } from "./context.js";
import { admissionProblems, periodCommandProblems, submissionProblems } from "./problem.js";

export const readReturningAssistantOptions = (
  headers: Headers.Headers,
  options: NativeRpcOptions,
) =>
  Effect.gen(function* () {
    const authorization = yield* returningAuthorization(
      headers,
      options,
      ReadReturningAssistantOptions,
    );

    const returningOptions = yield* ReturningAssistants.use(({ readOptions }) =>
      readOptions({
        personId: authorization.authority.personId,
        now: authorization.authorizationInstant,
      }),
    );

    return yield* strictOutput(ReturningAssistantOptionsSchema)(returningOptions);
  }).pipe(
    admissionProblems(headers, "returning.unavailable"),
    // Reading the options selects no team and runs no command.
    unreachable(
      "returning.team-scope-denied",
      "returning.revision-conflict",
      "idempotency.digest-conflict",
    ),
  );

export const listAdmissionPeriods = (headers: Headers.Headers, options: NativeRpcOptions) =>
  Effect.gen(function* () {
    const authority = yield* resolveRequestPersonAuthority(credentialRequestOf(headers), {
      now: options.now,
    });

    const actor = yield* admissionActorForAuthority(authority);
    const now = yield* currentInstant(options.config.admission.now);

    yield* authorizeAdmissionPerson(headers, {
      spec: Option.getOrThrow(reflectAccessSpec(ListAdmissionPeriods)),
      request: credentialRequestOf(headers),
      personId: actor.personId,
      resolution: {
        selection: "AllMatching",
        contexts: [
          genericContext({
            domainId: "admissions",
            departmentId: Predicate.isTagged(actor, "DepartmentAdministrator")
              ? actor.departmentId
              : null,
            authorityVersion: `admissions:${actor._tag}`,
          }),
        ],
      },
      grantScopes: admissionGrantScopes(actor),
      now,
    });

    const rows = yield* Admissions.use(({ listAdmissionPeriodsForManagement }) =>
      listAdmissionPeriodsForManagement({ actor, now }),
    );

    const items = rows.map((row) => ({
      id: row.id,
      departmentId: row.departmentId,
      semesterId: row.semesterId,
      startAt: row.startAt,
      endAt: row.endAt,
      revision: row.revision,
      etag: deriveStrongETag({
        representationKind: "AdmissionPeriodManagementItem",
        resourceIdentity: row.id,
        version: row.revision,
      }),
    }));

    return yield* strictOutput(AdmissionPeriodManagementListResponse)({
      items,
      totalItems: items.length,
    });
  }).pipe(
    admissionProblems(headers, "admissions.unavailable"),
    // A listing runs no revision, so no revision of it is stale.
    unreachable(...periodCommandProblems, "precondition.failed"),
  );

export const listOpenAdmissionPeriods = (headers: Headers.Headers, options: NativeRpcOptions) =>
  Effect.gen(function* () {
    const now = yield* currentInstant(options.config.admission.now);

    yield* authorizeAnonymous(
      Option.getOrThrow(reflectAccessSpec(ListOpenAdmissionPeriods)),
      {
        selection: "AllMatching",
        contexts: [
          genericContext({
            domainId: "admissions",
            authorityVersion: `admissions-open:${now}`,
          }),
        ],
      },
      now,
    );

    const rows = yield* Admissions.use(({ listOpenAdmissionPeriods }) =>
      listOpenAdmissionPeriods(now),
    );

    return yield* strictOutput(OpenAdmissionPeriodListResponse)({
      items: rows.map((row) => ({
        id: row.id,
        departmentId: row.departmentId,
        semesterId: row.semesterId,
        startAt: row.startAt,
        endAt: row.endAt,
      })),
      totalItems: rows.length,
    });
  }).pipe(
    admissionProblems(headers, "admissions.unavailable"),
    // The open listing resolves no actor and runs no revision.
    unreachable(
      ...periodCommandProblems,
      "precondition.failed",
      "credential.missing",
      "credential.invalid",
      "authority.denied",
    ),
  );

export const listApplicationOptions = (headers: Headers.Headers, options: NativeRpcOptions) =>
  Effect.gen(function* () {
    const now = yield* currentInstant(options.config.admission.now);

    yield* authorizeAnonymous(
      Option.getOrThrow(reflectAccessSpec(ListApplicationOptions)),
      {
        selection: "AllMatching",
        contexts: [
          genericContext({
            domainId: "admissions",
            authorityVersion: `admissions-catalog:${now}`,
          }),
        ],
      },
      now,
    );

    const source = yield* Admissions.use(({ listPublicApplicationCatalog }) =>
      listPublicApplicationCatalog({ now }),
    );

    return yield* strictOutput(PublicApplicationCatalogSchema)(source.catalog);
  }).pipe(
    admissionProblems(headers, "admissions.unavailable"),
    unreachable(...submissionProblems, "application.not-found"),
  );

export const readApplicationConfirmation = (
  headers: Headers.Headers,
  applicationId: PublicApplicationId,
  options: NativeRpcOptions,
) =>
  Effect.gen(function* () {
    const now = yield* currentInstant(options.config.admission.now);

    yield* authorizeAnonymous(
      Option.getOrThrow(reflectAccessSpec(ReadApplicationConfirmation)),
      {
        selection: "ExactlyOne",
        contexts: [
          genericContext({
            domainId: "admissions",
            resourceKind: "application",
            resourceId: applicationId,
            authorityVersion: `admissions-application:${applicationId}`,
          }),
        ],
      },
      now,
    );

    const confirmation = yield* Admissions.use(({ findPublicApplicationConfirmation }) =>
      findPublicApplicationConfirmation(applicationId),
    );

    return yield* strictOutput(PublicApplicationConfirmationSchema)(confirmation);
  }).pipe(
    admissionProblems(headers, "admissions.unavailable"),
    // The payload already decoded the identifier the confirmation lookup decodes again.
    unreachable(...submissionProblems),
  );

export const readApplicantProgress = (headers: Headers.Headers, options: NativeRpcOptions) =>
  Database.use((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;

        const authorization = yield* resolveRequestPersonAuthorityInTransaction(
          credentialRequestOf(headers),
          { now: options.config.admission.now },
        );

        yield* authorizeAdmissionPerson(headers, {
          spec: Option.getOrThrow(reflectAccessSpec(ReadApplicantProgress)),
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
                authorityVersion: "admissions:applicant-progress",
              }),
            ],
          },
          grantScopes: [returningPersonResource(authorization.authority.personId)],
          now: authorization.authorizationInstant,
        });

        const progress = yield* Admissions.use(({ readApplicantProgress }) =>
          readApplicantProgress(
            authorization.authority.personId,
            authorization.authorizationInstant,
          ),
        );

        return yield* strictOutput(ApplicantProgressResponseSchema)(progress);
      }),
    ),
  ).pipe(
    // A snapshot the database cannot open or commit leaves the service unavailable.
    Effect.catchTag("SqlError", () => Effect.fail(Problem.make("admissions.unavailable"))),
    admissionProblems(headers, "admissions.unavailable"),
    unreachable(...submissionProblems, "application.not-found"),
  );
