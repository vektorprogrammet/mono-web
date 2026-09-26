/** Admission read handlers: admission periods, public applications, and returning assistants. */
import { Database } from "@vektorprogrammet/database";
import { Admissions } from "@vektorprogrammet/domain/admissions";
import {
  ApplicantProgressResponseSchema,
  ReturningAssistantOptionsSchema,
  ReturningAssistants,
} from "@vektorprogrammet/domain/application";
import {
  AdmissionPeriodManagementItem,
  ListAdmissionPeriodsEndpoint,
  ListOpenAdmissionPeriodsEndpoint,
  ReadApplicantProgressEndpoint,
  ReadApplicationCatalogEndpoint,
  ReadApplicationConfirmationEndpoint,
  ReadReturningAssistantOptionsEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Option, Predicate, Schema } from "effect";
import { currentInstant, resolveRequestPersonAuthorityInTransaction } from "../authority.js";
import {
  authorizeAnonymous,
  requireNoQuery,
  strictOutput,
  unreachable,
} from "../http-api/problem.js";
import { PRIVATE_NO_STORE, deriveStrongETag } from "../http-semantics.js";
import { genericContext } from "../native-operation.js";
import {
  admissionGrantScopes,
  authorizeAdmissionPerson,
  returningAuthorization,
  returningPersonResource,
} from "./http-access.js";
import { requireActive, type AdmissionApiHttpOptions } from "./http-context.js";
import { admissionProblems, periodCommandProblems, submissionProblems } from "./http-problem.js";
import {
  conditionalCollection,
  dynamicAdmissionCache,
  jsonResponse,
} from "./http-representation.js";

export const readReturningAssistantOptions = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const authorization = yield* returningAuthorization(
      request,
      input,
      ReadReturningAssistantOptionsEndpoint,
    );

    const options = yield* ReturningAssistants.use(({ readOptions }) =>
      readOptions({
        personId: authorization.authority.personId,
        now: authorization.authorizationInstant,
      }),
    );

    const body = yield* strictOutput(ReturningAssistantOptionsSchema)(options);

    return jsonResponse(body);
  }).pipe(
    admissionProblems(request, "returning.unavailable"),
    // Reading the options selects no team and runs no command.
    unreachable(
      "returning.team-scope-denied",
      "returning.revision-conflict",
      "idempotency.digest-conflict",
    ),
  );

export const listAdmissionPeriods = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const actor = yield* input.resolveActor(request).pipe(Effect.flatMap(requireActive));
    const now = yield* currentInstant(input.config.now);
    yield* authorizeAdmissionPerson(request, {
      spec: Option.getOrThrow(reflectAccessSpec(ListAdmissionPeriodsEndpoint)),
      request,
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

    const body = yield* strictOutput(
      Schema.Struct({ items: Schema.Array(AdmissionPeriodManagementItem), totalItems: Schema.Int }),
    )({ items, totalItems: items.length });

    return yield* conditionalCollection({
      request,
      body,
      representationKind: "AdmissionPeriodManagementListResponse",
      version: rows.map((row) => [row.id, row.revision] as const),
      cacheControl: PRIVATE_NO_STORE,
    });
  }).pipe(
    admissionProblems(request, "admissions.unavailable"),
    unreachable(...periodCommandProblems),
  );

export const listOpenAdmissionPeriods = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const now = yield* currentInstant(input.config.now);
    yield* authorizeAnonymous(
      Option.getOrThrow(reflectAccessSpec(ListOpenAdmissionPeriodsEndpoint)),
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

    const body = {
      items: rows.map((row) => ({
        id: row.id,
        departmentId: row.departmentId,
        semesterId: row.semesterId,
        startAt: row.startAt,
        endAt: row.endAt,
      })),
      totalItems: rows.length,
    };

    return yield* conditionalCollection({
      request,
      body,
      representationKind: "OpenAdmissionPeriodListResponse",
      version: rows.map((row) => [row.id, row.revision] as const),
      cacheControl: dynamicAdmissionCache(
        now,
        rows.flatMap((row) => [row.startAt, row.endAt]),
      ),
    });
  }).pipe(
    admissionProblems(request, "admissions.unavailable"),
    // The open listing resolves no actor.
    unreachable(
      ...periodCommandProblems,
      "credential.missing",
      "credential.invalid",
      "authority.denied",
    ),
  );

export const listApplicationOptions = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const now = yield* currentInstant(input.config.now);
    yield* authorizeAnonymous(
      Option.getOrThrow(reflectAccessSpec(ReadApplicationCatalogEndpoint)),
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

    return yield* conditionalCollection({
      request,
      body: source.catalog,
      representationKind: "PublicApplicationCatalog",
      version: {
        intervalIdentity: source.validatorSource.intervalIdentity,
        itemRevisions: source.validatorSource.itemRevisions,
      },
      cacheControl: dynamicAdmissionCache(
        now,
        source.catalog.departments.map((department) => department.closesAt),
      ),
    });
  }).pipe(
    admissionProblems(request, "admissions.unavailable"),
    unreachable(...submissionProblems, "application.not-found"),
  );

export const readApplicationConfirmation = (
  request: Request,
  applicationId: string,
  input: AdmissionApiHttpOptions,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const now = yield* currentInstant(input.config.now);
    yield* authorizeAnonymous(
      Option.getOrThrow(reflectAccessSpec(ReadApplicationConfirmationEndpoint)),
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

    return jsonResponse(confirmation);
  }).pipe(
    admissionProblems(request, "admissions.unavailable"),
    // The path already decoded the identifier the confirmation lookup decodes again.
    unreachable(...submissionProblems),
  );

export const readApplicantProgress = (request: Request, input: AdmissionApiHttpOptions) =>
  Database.use((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* requireNoQuery(request);

        yield* Database.use(
          (transaction) => transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`,
        );

        const authorization = yield* resolveRequestPersonAuthorityInTransaction(request, {
          now: input.config.now,
        });

        yield* authorizeAdmissionPerson(request, {
          spec: Option.getOrThrow(reflectAccessSpec(ReadApplicantProgressEndpoint)),
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

        const body = yield* Admissions.use(({ readApplicantProgress }) =>
          readApplicantProgress(
            authorization.authority.personId,
            authorization.authorizationInstant,
          ),
        );

        const decoded = yield* strictOutput(ApplicantProgressResponseSchema)(body);

        return new Response(JSON.stringify(decoded), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "private, no-store",
            "referrer-policy": "no-referrer",
            vary: "Origin",
          },
        });
      }),
    ),
  ).pipe(
    // A snapshot the database cannot open or commit leaves the service unavailable.
    Effect.catchTag("SqlError", () => Effect.fail(Problem.make("admissions.unavailable"))),
    admissionProblems(request, "admissions.unavailable"),
    unreachable(...submissionProblems, "application.not-found"),
  );
