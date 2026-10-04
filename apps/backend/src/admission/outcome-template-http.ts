/**
 * The three handlers of the outcome message templates. The closed document, its validation, the
 * renderer and the revision store belong to the template modules; this file decides who may call
 * them and answers the HTTP semantics: private no-store reads, strong ETags, and a replayable,
 * preconditioned save.
 */
import {
  readOutcomeTemplates as readStoredTemplates,
  saveOutcomeTemplate as saveStoredTemplate,
} from "@vektorprogrammet/database/admissions/outcome-template-store";
import { Scope } from "@vektorprogrammet/domain/authz";
import {
  decodeOutcomeTemplateDraft,
  outcomeTemplateAuthority,
  type OutcomeTemplateKind,
  type OutcomeTemplateSet,
} from "@vektorprogrammet/domain/admissions/template";
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import {
  OutcomeTemplateResource,
  PreviewOutcomeTemplateEndpoint,
  ReadOutcomeTemplatesEndpoint,
  RenderedOutcomeMail,
  SaveOutcomeTemplateEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Option, Schema } from "effect";
import {
  resolveRequestPersonAuthorityInTransaction,
  type TransactionPersonAuthority,
} from "../authority.js";
import {
  authorizePerson,
  commandOutcomeResponse,
  commandReceiptProblems,
  conditionalJson,
  decodeRequest,
  httpIdentity,
  idempotencyKeyOf,
  jsonText,
  personPresentation,
  readJsonBody,
  requireCurrentETag,
  requiredIfMatchOf,
  strictOutput,
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
import { outcomeJson, outcomeProblems, outcomeSnapshotRead } from "./outcome-http-support.js";
import { previewOutcomeTemplate as previewRendered } from "./template-render.js";

/** A template document holds at most a hundred blocks, so it needs more room than a command. */
const MAX_TEMPLATE_BYTES = 65_536;

const JSON_MEDIA_TYPE = /^application\/json(?:\s*;|$)/u;

const TemplateQuery = Schema.Struct({ departmentId: Schema.optional(DepartmentId) });

/** The draft and sample are decoded by the template module, so only the three members are named here. */
const PreviewRequest = Schema.Struct({
  subject: Schema.Unknown,
  body: Schema.Unknown,
  sample: Schema.Unknown,
});

/** One ETag for the set of effective revisions of a scope: a department's save moves no other scope's tag. */
const templateResource = (set: OutcomeTemplateSet) => ({
  ...set,
  etag: deriveStrongETag({
    representationKind: "OutcomeTemplateResource",
    resourceIdentity: set.departmentId ?? "global",
    version: set.templates.map((template) => `${template.kind}:${template.revisionId}`),
  }),
});

type Endpoint =
  | typeof ReadOutcomeTemplatesEndpoint
  | typeof PreviewOutcomeTemplateEndpoint
  | typeof SaveOutcomeTemplateEndpoint;

/**
 * Refuses a person who may not read or edit the scope's templates, then evaluates the declared
 * AccessSpec. No departmentId is the global default, which only a global administrator edits.
 */
const authorizeTemplates = (
  request: Request,
  endpoint: Endpoint,
  departmentId: DepartmentId | undefined,
  need: "read" | "edit",
  auth: TransactionPersonAuthority,
) =>
  Effect.gen(function* () {
    const permission = outcomeTemplateAuthority(auth.authority, departmentId);

    if (!(need === "read" ? permission.read : permission.edit))
      return yield* Problem.make("authority.denied");

    yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
        credential: auth.credential,
        personId: auth.authority.personId,
        resolution: {
          selection: "ExactlyOne",
          contexts: [
            genericContext({
              domainId: "admissions",
              departmentId,
              authorityVersion: auth.authorizationInstant,
            }),
          ],
        },
        grantScopes: [
          departmentId === undefined ? Scope.Global() : Scope.Department({ departmentId }),
        ],
        now: auth.authorizationInstant,
      },
      personPresentation(request),
    );
  });

/** The one optional `departmentId` of a template operation; any other or repeated query member is malformed. */
const selectedDepartment = (request: Request) =>
  Effect.gen(function* () {
    const parameters = new URL(request.url).searchParams;
    const keys = [...parameters.keys()];

    if (
      keys.some((key) => key !== "departmentId") ||
      keys.some((key) => parameters.getAll(key).length !== 1)
    )
      return yield* Problem.make("request.malformed");

    return (yield* decodeRequest(TemplateQuery)(Object.fromEntries(parameters))).departmentId;
  });

export const OutcomeTemplateHandlers = (input: { now?: () => string }) => {
  const personAuthority = (request: Request) =>
    resolveRequestPersonAuthorityInTransaction(request, { now: input.now });

  const readOutcomeTemplates = (request: Request) =>
    outcomeSnapshotRead(
      request,
      Effect.gen(function* () {
        const departmentId = yield* selectedDepartment(request);
        const auth = yield* personAuthority(request);

        yield* authorizeTemplates(
          request,
          ReadOutcomeTemplatesEndpoint,
          departmentId,
          "read",
          auth,
        );

        const set = yield* readStoredTemplates({ departmentId });
        const resource = yield* strictOutput(OutcomeTemplateResource)(templateResource(set));

        return yield* conditionalJson({
          request,
          body: resource,
          etag: resource.etag,
          cacheControl: PRIVATE_NO_STORE,
          contentType: "application/json",
        });
      }),
    );

  const previewOutcomeTemplate = (request: Request, kind: OutcomeTemplateKind) =>
    outcomeSnapshotRead(
      request,
      Effect.gen(function* () {
        const departmentId = yield* selectedDepartment(request);

        const body = yield* readJsonBody(request, JSON_MEDIA_TYPE, MAX_TEMPLATE_BYTES);
        const { subject, body: document, sample } = yield* decodeRequest(PreviewRequest)(body);
        const auth = yield* personAuthority(request);

        yield* authorizeTemplates(
          request,
          PreviewOutcomeTemplateEndpoint,
          departmentId,
          "edit",
          auth,
        );

        const rendered = yield* previewRendered({
          kind,
          draft: { subject, body: document },
          sample,
        });

        return yield* outcomeJson(yield* strictOutput(RenderedOutcomeMail)(rendered));
      }),
    );

  const saveOutcomeTemplate = (request: Request, kind: OutcomeTemplateKind) =>
    Effect.gen(function* () {
      const departmentId = yield* selectedDepartment(request);
      const body = yield* readJsonBody(request, JSON_MEDIA_TYPE, MAX_TEMPLATE_BYTES);
      const ifMatch = yield* requiredIfMatchOf(request);
      const idempotencyKey = yield* idempotencyKeyOf(request);
      const operationId = "admissionOutcomes.saveOutcomeTemplate";

      // The department is part of the target, so one key never replays another scope's save.
      const normalizedTarget =
        departmentId === undefined
          ? normalizeTarget("/api/admission-outcomes/templates/{kind}", { kind })
          : normalizeTarget("/api/admission-outcomes/templates/{kind}/departments/{departmentId}", {
              kind,
              departmentId,
            });

      // Failures are answered after the executor, which rolls the whole command back on any of them.
      const outcome = yield* executeNativeHttpCommandPostgres(
        Effect.gen(function* () {
          const auth = yield* personAuthority(request);

          yield* authorizeTemplates(
            request,
            SaveOutcomeTemplateEndpoint,
            departmentId,
            "edit",
            auth,
          );

          // The same strict decoding as the preview and the renderer: an unsafe draft never reaches storage.
          const draft = yield* decodeOutcomeTemplateDraft(kind)(body);

          const identity = yield* httpIdentity({
            credentialSubject: `Person:${auth.authority.personId}`,
            qualifiedOperationId: operationId,
            normalizedTarget,
            idempotencyKey,
          });

          return {
            identity: {
              identitySha256: identity.identitySha256,
              requestSha256: semanticRequestDigest(semanticMutationRequest(body, ifMatch)),
              operationId,
            },
            execute: Effect.gen(function* () {
              const saved = yield* saveStoredTemplate(
                {
                  kind,
                  departmentId,
                  draft,
                  actor: auth.authority.personId,
                  now: auth.authorizationInstant,
                },
                (current) => requireCurrentETag(templateResource(current).etag, ifMatch),
              );

              const resource = yield* strictOutput(OutcomeTemplateResource)(
                templateResource(saved),
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

  return { readOutcomeTemplates, previewOutcomeTemplate, saveOutcomeTemplate };
};
