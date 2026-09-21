import { randomUUID } from "node:crypto";
import {
  SchoolSurveys,
  SurveyId,
  SurveyResponseId,
  type PreparedSchoolSurveyResponse,
} from "@vektorprogrammet/domain";
import { Database } from "@vektorprogrammet/domain/database";
import { executeNativeHttpCommandPostgres } from "@vektorprogrammet/domain/http-semantics";
import {
  ExternalNativeApi,
  makeNativeValidationError,
  ReadSchoolSurveyEndpoint,
  SchoolSurveyFormResource,
  SchoolSurveyResponseResource,
  SubmitSchoolSurveyResponseEndpoint,
  SubmitSchoolSurveyResponseRequest,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { readBoundedJson } from "../http-api/read-json.js";
import { toHttpApiResponse } from "../http-api/transport.js";
import {
  HttpSemanticFailure,
  deriveHttpIdentity,
  deriveStrongETag,
  encodePathIdentity,
  jsonBodyBytes,
  nativeProblemResponse,
  parseIdempotencyKey,
  semanticRequestDigest,
  validationProblemResponse,
} from "../http-semantics.js";
import {
  authorizeAnonymousNativeOperation,
  genericContext,
  nativeCommandOutcomeResponse,
  prepareNativeHttpCommand,
  withNativeHttpRuntime,
} from "../native-operation.js";
import type { BackendRun } from "../router.js";

const maxSubmitBodyBytes = 65_536;

type Endpoint = typeof ReadSchoolSurveyEndpoint | typeof SubmitSchoolSurveyResponseEndpoint;

const noQuery = (request: Request): void => {
  if (new URL(request.url).search !== "") {
    throw new HttpSemanticFailure("request.malformed", 400);
  }
};

const strictDecode = async <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
  run: BackendRun,
  code: "request.malformed" | "validation.failed" | "internal.error",
): Promise<S["Type"]> =>
  run(
    Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
      Effect.mapError(
        () =>
          new HttpSemanticFailure(
            code,
            code === "request.malformed" ? 400 : code === "validation.failed" ? 422 : 500,
          ),
      ),
    ),
  );

const transactionInstant = (run: BackendRun): Promise<string> =>
  run(
    Database.use((sql) =>
      sql<{ readonly now: string }>`
        SELECT to_char(
          transaction_timestamp() AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS now
      `.pipe(
        Effect.flatMap((rows) => {
          const now = rows[0]?.now;
          return now === undefined
            ? Effect.fail(new HttpSemanticFailure("internal.error", 500))
            : Effect.succeed(now);
        }),
      ),
    ).pipe(
      Effect.catchTag("SqlError", () =>
        Effect.fail(new HttpSemanticFailure("dependency.unavailable", 503)),
      ),
    ),
  );

const authorizeAnonymous = async (
  endpoint: Endpoint,
  surveyId: SurveyId,
  now: string,
  run: BackendRun,
): Promise<void> =>
  authorizeAnonymousNativeOperation(
    Option.getOrThrow(reflectAccessSpec(endpoint)),
    {
      selection: "ExactlyOne",
      contexts: [
        genericContext({
          domainId: "surveys",
          resourceKind: "school-survey",
          resourceId: String(surveyId),
          authorityVersion: now,
        }),
      ],
    },
    now,
    run,
  );

/** Uses the service's position-normalized representation for idempotency semantics. */
const canonicalRequest = (prepared: PreparedSchoolSurveyResponse) => ({
  schoolId: prepared.schoolId,
  answers: prepared.answers.map((answer) =>
    answer.kind === "Check"
      ? { kind: answer.kind, questionId: answer.questionId, values: answer.values }
      : { kind: answer.kind, questionId: answer.questionId, value: answer.value },
  ),
});

const read = async (request: Request, surveyId: SurveyId, run: BackendRun): Promise<Response> => {
  noQuery(request);
  return run(
    Database.use((sql) =>
      sql.withTransaction(
        withNativeHttpRuntime(run, async (txRun) => {
          await txRun(
            Database.use(
              (transaction) =>
                transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
            ),
          );
          const now = await transactionInstant(txRun);
          await authorizeAnonymous(ReadSchoolSurveyEndpoint, surveyId, now, txRun);
          const body = await txRun(SchoolSurveys.use(({ readForm }) => readForm(surveyId)));
          const response = await strictDecode(
            SchoolSurveyFormResource,
            body,
            txRun,
            "internal.error",
          );
          return new Response(JSON.stringify(response), {
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
              vary: "Origin",
            },
          });
        }),
      ),
    ),
  );
};

const submit = async (request: Request, surveyId: SurveyId, run: BackendRun): Promise<Response> => {
  noQuery(request);
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new HttpSemanticFailure("media-type.unsupported", 415);
  }
  const body = await strictDecode(
    SubmitSchoolSurveyResponseRequest,
    await readBoundedJson(request, maxSubmitBodyBytes),
    run,
    "validation.failed",
  );
  const idempotencyKeyHeader = request.headers.get("idempotency-key");
  const idempotencyKey = parseIdempotencyKey(
    idempotencyKeyHeader === null ? [] : [idempotencyKeyHeader],
  );
  const operationId = "surveys.submitSchoolSurveyResponse";
  const outcome = await run(
    executeNativeHttpCommandPostgres(
      prepareNativeHttpCommand(run, async (txRun) => {
        const now = await transactionInstant(txRun);
        await authorizeAnonymous(SubmitSchoolSurveyResponseEndpoint, surveyId, now, txRun);
        const prepared = await txRun(
          SchoolSurveys.use(({ prepareResponse }) => prepareResponse({ surveyId, request: body })),
        );
        const identity = deriveHttpIdentity({
          credentialSubject: "Anonymous",
          qualifiedOperationId: operationId,
          normalizedTarget: `/api/surveys/${encodePathIdentity(surveyId)}/responses`,
          idempotencyKey,
        });
        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: canonicalRequest(prepared) }),
            operationId,
          },
          execute: SchoolSurveys.use(({ persistResponse }) =>
            Effect.gen(function* () {
              const response = yield* persistResponse({
                responseId: SurveyResponseId.make(`survey_response_${randomUUID()}`),
                prepared,
              });
              const decoded = yield* Schema.decodeUnknownEffect(SchoolSurveyResponseResource)(
                response,
                {
                  onExcessProperty: "error",
                },
              ).pipe(Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)));
              return {
                status: 201,
                mediaType: "application/json",
                headers: {
                  "content-type": "application/json",
                  etag: deriveStrongETag({
                    representationKind: "school-survey-response",
                    resourceIdentity: decoded.responseId,
                    version: decoded.submittedAt,
                  }),
                  location: `/api/surveys/${encodePathIdentity(surveyId)}/responses/${encodePathIdentity(decoded.responseId)}`,
                },
                bodyBytes: jsonBodyBytes(decoded),
              };
            }),
          ),
        };
      }),
      {
        retry: "serialization-or-unique-once",
        retryUniqueConstraints: ["native_http_idempotency_receipts_pkey"],
      },
    ),
  );
  return nativeCommandOutcomeResponse(outcome);
};

const schoolSurveyValidationProblem = (): Response =>
  validationProblemResponse("validation.failed", [makeNativeValidationError("", "invalid")]);

const errorResponse = (cause: unknown): Response => {
  if (cause instanceof HttpSemanticFailure) {
    return cause.code === "validation.failed"
      ? schoolSurveyValidationProblem()
      : nativeProblemResponse(cause.code, cause.status);
  }
  const tag =
    cause !== null && typeof cause === "object" && "_tag" in cause && typeof cause._tag === "string"
      ? cause._tag
      : undefined;
  switch (tag) {
    case "SchoolSurveyNotFound":
      return nativeProblemResponse("resource.not-found", 404);
    case "SchoolSurveyValidationFailed":
      return schoolSurveyValidationProblem();
    case "SchoolSurveyPersistenceError":
    case "SqlError":
      return nativeProblemResponse("dependency.unavailable", 503);
    case "NativeHttpReceiptPersistenceError":
      return nativeProblemResponse("idempotency.unavailable", 503);
    case "SchoolSurveyDecodeError":
      return nativeProblemResponse("internal.error", 500);
    default:
      return nativeProblemResponse("internal.error", 500);
  }
};

/** Native HttpApi handlers for anonymous school-survey participation. */
export const SchoolSurveysApiHandlers = (run: BackendRun) =>
  HttpApiBuilder.group(ExternalNativeApi, "surveys", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readSchoolSurvey", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => read(webRequest, params.surveyId, run),
            errorResponse,
          ),
        )
        .handleRaw("submitSchoolSurveyResponse", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => submit(webRequest, params.surveyId, run),
            errorResponse,
          ),
        ),
    ),
  );
