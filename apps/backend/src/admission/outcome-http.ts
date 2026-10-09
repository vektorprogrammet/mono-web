/**
 * EX-0024: required public native APIs in stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import {
  AdmissionOutcomeCommand,
  AdmissionOutcomeScope,
  AdmissionOutcomeScopes,
  Admissions,
  admissionOutcomePermission,
  canAnnounceAdmissionOutcome,
  type AdmissionOutcomeEntry,
} from "@vektorprogrammet/domain/admissions";
import { Scope } from "@vektorprogrammet/domain/authz";
import {
  AdmissionOutcomeAnnounceCommand,
  AdmissionOutcomeAnnounceResource,
  AdmissionOutcomeBoardResource,
  AdmissionOutcomeResource,
  announceOutcome as announceOutcomeEndpoint,
  decideOutcome as decideOutcomeEndpoint,
  ExternalNativeApi,
  listScopes as listScopesEndpoint,
  previewOutcomeTemplate as previewOutcomeTemplateEndpoint,
  readOutcome as readOutcomeEndpoint,
  readOutcomes as readOutcomesEndpoint,
  readOutcomeTemplates as readOutcomeTemplatesEndpoint,
  saveOutcomeTemplate as saveOutcomeTemplateEndpoint,
} from "@vektorprogrammet/http-api";
import { Problem, type StrongETag } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Match } from "effect";
import type { HttpApiGroup } from "effect/http-api";
import {
  type AdmissionOutcomesGuards,
  type AdmissionOutcomesRawHandlers,
  AdmissionOutcomesApiHandlers as GeneratedAdmissionOutcomesApiHandlers,
} from "../../.effx/generated/admissionOutcomes-handlers.js";
import {
  resolveRequestPersonAuthorityInTransaction,
  type TransactionPersonAuthority,
} from "../authority.js";
import {
  commandOutcomeResponse,
  commandReceiptProblems,
  conditionalJson,
  decodeRequest,
  httpIdentity,
  idempotencyKeyOf,
  personPresentation,
  readJsonBody,
  requireCurrentETag,
  requiredIfMatchOf,
  requireNoQuery,
  strictOutput,
  webHandler,
  jsonText,
} from "../http-api/problem.js";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  deriveStrongETag,
  normalizeTarget,
  PRIVATE_NO_STORE,
  semanticMutationRequest,
  semanticRequestDigest,
} from "../http-semantics.js";
import { genericContext } from "../native-operation.js";
import { authorizeAt, personGuard, type OutcomePersonAuthorize } from "./http-guard.js";
import {
  MAX_MUTATION_BYTES,
  outcomeJson,
  outcomeProblems,
  outcomeSnapshotRead,
} from "./outcome-http-support.js";
import { renderOutcomeMail } from "./template-render.js";
import { OutcomeTemplateHandlers } from "./outcome-template-http.js";

const fullOutcomeKind = "AdmissionOutcomeResource";

const minimalOutcomeKind = "AdmissionOutcomeAnnounceResource";

const outcomeETag = (
  entry: AdmissionOutcomeEntry,
  representationKind: typeof fullOutcomeKind | typeof minimalOutcomeKind,
  version: string,
): StrongETag =>
  deriveStrongETag({
    representationKind,
    resourceIdentity: entry.applicationId,
    version,
  });

/** Selects only current representations allowed by this transaction's fresh authority. */
const currentAnnouncementETag = (
  entry: AdmissionOutcomeEntry,
  decide: boolean,
  ifMatch: StrongETag,
): StrongETag => {
  const version = JSON.stringify(entry);
  const minimal = outcomeETag(entry, minimalOutcomeKind, version);

  if (minimal === ifMatch || !decide) return minimal;

  const full = outcomeETag(entry, fullOutcomeKind, version);

  return full === ifMatch ? full : minimal;
};

/** Rekruttering's view of one application, with the ETag of its current state. */
const outcomeResource = (entry: AdmissionOutcomeEntry) => ({
  ...entry,
  etag: outcomeETag(entry, fullOutcomeKind, JSON.stringify(entry)),
});

/** The school coordinator's view: the safe fields, and an ETag that every change of the entry moves. */
const announceResource = (entry: AdmissionOutcomeEntry) => ({
  applicationId: entry.applicationId,
  firstName: entry.firstName,
  lastName: entry.lastName,
  state: entry.state,
  outcome: entry.outcome,
  placed: entry.placed,
  etag: outcomeETag(entry, minimalOutcomeKind, JSON.stringify(entry)),
});

/** Who an operation needs: the board is open to either, a command to its own authority. */
type Requirement = "Either" | "Decide" | "Announce";

/**
 * Resolves what the person holds in the department now, refuses a person who lacks the operation's
 * authority, then evaluates the declared AccessSpec through the generated guard. A plain
 * department member holds neither.
 */
const authorizeOutcome = (
  authorize: OutcomePersonAuthorize,
  operation: string,
  request: Request,
  departmentId: AdmissionOutcomeEntry["departmentId"],
  requirement: Requirement,
  auth: TransactionPersonAuthority,
) =>
  Effect.gen(function* () {
    const decide = admissionOutcomePermission(auth.authority, departmentId) === "Decide";
    const announce = canAnnounceAdmissionOutcome(auth.authority, departmentId);

    const permitted = Match.value(requirement).pipe(
      Match.when("Decide", () => decide),
      Match.when("Announce", () => announce),
      Match.when("Either", () => decide || announce),
      Match.exhaustive,
    );

    if (!permitted) return yield* Problem.make("authority.denied");

    yield* authorizeAt(authorize, {
      kind: "Person",
      operation,
      request,
      input: {
        credential: auth.credential,
        personId: auth.authority.personId,
        resolution: {
          selection: "ExactlyOne",
          contexts: [
            genericContext({
              domainId: "admissions",
              departmentId,
              authorityVersion: auth.authorizationInstant,
              facts: { departmentCoordinatorPersonIds: announce ? [auth.authority.personId] : [] },
            }),
          ],
        },
        grantScopes: [Scope.Department({ departmentId })],
        now: auth.authorizationInstant,
      },
    });

    return { decide, announce };
  });

type AdmissionOutcomesEndpoints = HttpApiGroup.Endpoints<
  (typeof ExternalNativeApi)["groups"]["admissionOutcomes"]
>;

/**
 * The guards evaluate each endpoint's declared AccessSpec at the decision point of its raw
 * handler, after the handler has resolved what the person holds in the department.
 */
export const admissionOutcomesGuards = {
  "admissionOutcomes.announceOutcome": () =>
    personGuard("admissionOutcomes.announceOutcome", announceOutcomeEndpoint),
  "admissionOutcomes.decideOutcome": () =>
    personGuard("admissionOutcomes.decideOutcome", decideOutcomeEndpoint),
  "admissionOutcomes.listScopes": () =>
    personGuard("admissionOutcomes.listScopes", listScopesEndpoint),
  "admissionOutcomes.previewOutcomeTemplate": () =>
    personGuard("admissionOutcomes.previewOutcomeTemplate", previewOutcomeTemplateEndpoint),
  "admissionOutcomes.readOutcome": () =>
    personGuard("admissionOutcomes.readOutcome", readOutcomeEndpoint),
  "admissionOutcomes.readOutcomeTemplates": () =>
    personGuard("admissionOutcomes.readOutcomeTemplates", readOutcomeTemplatesEndpoint),
  "admissionOutcomes.readOutcomes": () =>
    personGuard("admissionOutcomes.readOutcomes", readOutcomesEndpoint),
  "admissionOutcomes.saveOutcomeTemplate": () =>
    personGuard("admissionOutcomes.saveOutcomeTemplate", saveOutcomeTemplateEndpoint),
} satisfies AdmissionOutcomesGuards<AdmissionOutcomesEndpoints>;

export const AdmissionOutcomesApiHandlers = (input: { now?: () => string }) => {
  const personAuthority = (request: Request) =>
    resolveRequestPersonAuthorityInTransaction(request, { now: input.now });

  const templates = OutcomeTemplateHandlers(input);

  const listScopes = (request: Request, authorize: OutcomePersonAuthorize) =>
    outcomeSnapshotRead(
      request,
      Effect.gen(function* () {
        yield* requireNoQuery(request);

        const auth = yield* personAuthority(request);

        const scopes = yield* Admissions.use((admissions) =>
          admissions.listAdmissionOutcomeScopes(auth.authority),
        );

        for (const department of scopes.departments)
          yield* authorizeOutcome(
            authorize,
            "admissionOutcomes.listScopes",
            request,
            department.departmentId,
            "Either",
            auth,
          );

        return yield* outcomeJson(yield* strictOutput(AdmissionOutcomeScopes)(scopes));
      }),
    );

  const readOutcomes = (request: Request, authorize: OutcomePersonAuthorize) =>
    outcomeSnapshotRead(
      request,
      Effect.gen(function* () {
        const parameters = new URL(request.url).searchParams;
        const keys = [...parameters.keys()];

        if (
          keys.some((key) => key !== "departmentId" && key !== "semesterId") ||
          keys.some((key) => parameters.getAll(key).length !== 1)
        )
          return yield* Problem.make("request.malformed");

        const scope = yield* decodeRequest(AdmissionOutcomeScope)(Object.fromEntries(parameters));
        const auth = yield* personAuthority(request);

        const { decide, announce } = yield* authorizeOutcome(
          authorize,
          "admissionOutcomes.readOutcomes",
          request,
          scope.departmentId,
          "Either",
          auth,
        );

        const { admissionPeriodId, entries } = yield* Admissions.use((admissions) =>
          admissions.readAdmissionOutcomes(scope),
        );

        return yield* outcomeJson(
          yield* strictOutput(AdmissionOutcomeBoardResource)(
            decide
              ? AdmissionOutcomeBoardResource.cases.Decide.make({
                  ...scope,
                  admissionPeriodId,
                  canAnnounce: announce,
                  entries: entries.map(outcomeResource),
                })
              : AdmissionOutcomeBoardResource.cases.Announce.make({
                  ...scope,
                  admissionPeriodId,
                  entries: entries.map(announceResource),
                }),
          ),
        );
      }),
    );

  const readOutcome = (
    request: Request,
    applicationId: AdmissionOutcomeEntry["applicationId"],
    authorize: OutcomePersonAuthorize,
  ) =>
    outcomeSnapshotRead(
      request,
      Effect.gen(function* () {
        yield* requireNoQuery(request);

        const entry = yield* Admissions.use((admissions) =>
          admissions.readAdmissionOutcome(applicationId),
        );

        const auth = yield* personAuthority(request);
        yield* authorizeOutcome(
          authorize,
          "admissionOutcomes.readOutcome",
          request,
          entry.departmentId,
          "Decide",
          auth,
        );
        const resource = yield* strictOutput(AdmissionOutcomeResource)(outcomeResource(entry));

        return yield* conditionalJson({
          request,
          body: resource,
          etag: resource.etag,
          cacheControl: PRIVATE_NO_STORE,
          contentType: "application/json",
        });
      }),
    );

  const decideOutcome = (
    request: Request,
    applicationId: AdmissionOutcomeEntry["applicationId"],
    authorize: OutcomePersonAuthorize,
  ) =>
    Effect.gen(function* () {
      yield* requireNoQuery(request);

      const body = yield* readJsonBody(
        request,
        /^application\/json(?:\s*;|$)/u,
        MAX_MUTATION_BYTES,
      );

      const command = yield* decodeRequest(AdmissionOutcomeCommand)(body);
      const ifMatch = yield* requiredIfMatchOf(request);
      const idempotencyKey = yield* idempotencyKeyOf(request);
      const operationId = "admissionOutcomes.decideOutcome";

      // Failures are answered after the executor, which rolls the whole command back on any of them.
      const outcome = yield* executeNativeHttpCommandPostgres(
        Effect.gen(function* () {
          const selected = yield* Admissions.use((admissions) =>
            admissions.readAdmissionOutcome(applicationId),
          );

          const auth = yield* personAuthority(request);

          yield* authorizeOutcome(
            authorize,
            "admissionOutcomes.decideOutcome",
            request,
            selected.departmentId,
            "Decide",
            auth,
          );

          const identity = yield* httpIdentity({
            credentialSubject: `Person:${auth.authority.personId}`,
            qualifiedOperationId: operationId,
            normalizedTarget: normalizeTarget("/api/admission-outcomes/{applicationId}:decide", {
              applicationId,
            }),
            idempotencyKey,
          });

          return {
            identity: {
              identitySha256: identity.identitySha256,
              requestSha256: semanticRequestDigest(semanticMutationRequest(body, ifMatch)),
              operationId,
            },
            execute: Effect.gen(function* () {
              const changed = yield* Admissions.use((admissions) =>
                admissions.decideAdmissionOutcome(
                  {
                    applicationId,
                    command,
                    actor: auth.authority.personId,
                    now: auth.authorizationInstant,
                  },
                  (current) => requireCurrentETag(outcomeResource(current).etag, ifMatch),
                ),
              );

              const resource = yield* strictOutput(AdmissionOutcomeResource)(
                outcomeResource(changed),
              );

              return {
                status: 200,
                mediaType: "application/json",
                headers: { "content-type": "application/json", etag: resource.etag },
                bodyBytes: new TextEncoder().encode(yield* jsonText(resource)),
              };
            }),
          };
        }),
      ).pipe(outcomeProblems(personPresentation(request)), commandReceiptProblems);

      return yield* commandOutcomeResponse(outcome);
    });

  const announceOutcome = (
    request: Request,
    applicationId: AdmissionOutcomeEntry["applicationId"],
    authorize: OutcomePersonAuthorize,
  ) =>
    Effect.gen(function* () {
      yield* requireNoQuery(request);

      const body = yield* readJsonBody(
        request,
        /^application\/json(?:\s*;|$)/u,
        MAX_MUTATION_BYTES,
      );

      yield* decodeRequest(AdmissionOutcomeAnnounceCommand)(body);
      const ifMatch = yield* requiredIfMatchOf(request);
      const idempotencyKey = yield* idempotencyKeyOf(request);
      const operationId = "admissionOutcomes.announceOutcome";

      // The coordinator's authority is resolved here, in the committing transaction, also on a replay.
      const outcome = yield* executeNativeHttpCommandPostgres(
        Effect.gen(function* () {
          const selected = yield* Admissions.use((admissions) =>
            admissions.readAdmissionOutcome(applicationId),
          );

          const auth = yield* personAuthority(request);

          const permission = yield* authorizeOutcome(
            authorize,
            "admissionOutcomes.announceOutcome",
            request,
            selected.departmentId,
            "Announce",
            auth,
          );

          const identity = yield* httpIdentity({
            credentialSubject: `Person:${auth.authority.personId}`,
            qualifiedOperationId: operationId,
            normalizedTarget: normalizeTarget("/api/admission-outcomes/{applicationId}:announce", {
              applicationId,
            }),
            idempotencyKey,
          });

          return {
            identity: {
              identitySha256: identity.identitySha256,
              requestSha256: semanticRequestDigest(semanticMutationRequest(body, ifMatch)),
              operationId,
            },
            execute: Effect.gen(function* () {
              const announced = yield* Admissions.use((admissions) =>
                admissions.announceAdmissionOutcome(
                  {
                    applicationId,
                    actor: auth.authority.personId,
                    now: auth.authorizationInstant,
                  },
                  (current) =>
                    requireCurrentETag(
                      currentAnnouncementETag(current, permission.decide, ifMatch),
                      ifMatch,
                    ),
                  renderOutcomeMail,
                ),
              );

              const resource = yield* strictOutput(AdmissionOutcomeAnnounceResource)(
                announceResource(announced),
              );

              return {
                status: 200,
                mediaType: "application/json",
                headers: { "content-type": "application/json", etag: resource.etag },
                bodyBytes: new TextEncoder().encode(yield* jsonText(resource)),
              };
            }),
          };
        }),
      ).pipe(outcomeProblems(personPresentation(request)), commandReceiptProblems);

      // A stored capsule keeps no cache policy and replays as no-store; the announce answer is private.
      const response = yield* commandOutcomeResponse(outcome);
      response.headers.set("cache-control", PRIVATE_NO_STORE);

      return response;
    });

  const raw = {
    listScopes: ({ request }, authorize) =>
      webHandler(request, (webRequest) => listScopes(webRequest, authorize)),
    readOutcomes: ({ request }, authorize) =>
      webHandler(request, (webRequest) => readOutcomes(webRequest, authorize)),
    readOutcome: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) => readOutcome(webRequest, params.applicationId, authorize)),
    decideOutcome: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        decideOutcome(webRequest, params.applicationId, authorize),
      ),
    announceOutcome: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        announceOutcome(webRequest, params.applicationId, authorize),
      ),
    readOutcomeTemplates: ({ request }, authorize) =>
      webHandler(request, (webRequest) => templates.readOutcomeTemplates(webRequest, authorize)),
    previewOutcomeTemplate: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        templates.previewOutcomeTemplate(webRequest, params.kind, authorize),
      ),
    saveOutcomeTemplate: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        templates.saveOutcomeTemplate(webRequest, params.kind, authorize),
      ),
  } satisfies AdmissionOutcomesRawHandlers<
    AdmissionOutcomesEndpoints,
    typeof admissionOutcomesGuards
  >;

  return GeneratedAdmissionOutcomesApiHandlers({ raw, guards: admissionOutcomesGuards });
};
