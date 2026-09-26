/** Receipt command handlers: submit, revise, withdraw, approve/reject/reopen, and settle. */
import {
  Economy,
  ReceiptCommandRequestSchema,
  ReceiptDecodeError,
  ReceiptId,
  ReceiptMutationAuthorizationTarget,
  ReceiptPersistenceError,
  ReceiptSettlementCommandRequestSchema,
  ReceiptVisualId,
  type ReceiptCommandPrincipal,
  type ReceiptCommandRequest,
  type ReceiptFile,
  type ReceiptMutationAuthorization,
  type ReceiptSubmissionAllocation,
} from "@vektorprogrammet/domain/receipt";
import { Problem, type StrongETag } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Match, Predicate, type Schema } from "effect";
import {
  commandOutcomeResponse,
  commandReceiptProblems,
  decodeRequest,
  httpIdentity,
  idempotencyKeyOf,
  personPresentation,
  problemWebResponse,
  requireCurrentETag,
  requiredIfMatchOf,
  requireNoQuery,
  unreachable,
} from "../http-api/problem.js";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  PRIVATE_NO_STORE,
  semanticMutationRequest,
  semanticRequestDigest,
} from "../http-semantics.js";
import {
  RECEIPT_E2E_CONCURRENCY_RESPONSE_HEADER,
  type ReceiptE2ETransactionBarrier,
} from "./e2e-support.js";
import type { ReceiptFileStore, StagedReceiptFile } from "./filesystem.js";
import {
  authorizationPrincipalInTransaction,
  type ReceiptApiHttpOptions,
  type ReceiptIdentityFailure,
} from "./http-context.js";
import {
  decodeExactEmptyJson,
  decodeReviseMultipart,
  decodeSettlementRequest,
  decodeSubmitMultipart,
  decodeSubmitQuery,
} from "./http-decode.js";
import { receiptCredentialProblems, receiptProblems } from "./http-problem.js";
import {
  receiptEtag,
  receiptMutationCapsule,
  settlementMutationCapsule,
} from "./http-representation.js";
import { drainReceiptOutbox } from "./outbox-drain.js";

export type ReceiptApprovalRoute = {
  readonly action: "approve" | "reject" | "reopen";
  readonly receiptId: string;
};

const mutationIdentity = (
  request: Request,
  principal: ReceiptCommandPrincipal,
  qualifiedOperationId: string,
  normalizedTarget: string,
) =>
  idempotencyKeyOf(request).pipe(
    Effect.flatMap((idempotencyKey) =>
      httpIdentity({
        credentialSubject: `Person:${principal.personId}`,
        qualifiedOperationId,
        normalizedTarget,
        idempotencyKey,
      }),
    ),
  );

interface PreparedReceiptMutation {
  readonly identity: {
    readonly identitySha256: string;
    readonly commandId: string;
  };
  readonly operationId: string;
  readonly requestSha256: string;
  readonly command: ReceiptCommandRequest;
  readonly authorization: ReceiptMutationAuthorization;
  readonly response:
    | { readonly status: 201; readonly location: string }
    | { readonly status: 200; readonly ifMatch: StrongETag; readonly currentEtag: StrongETag };
  readonly allocation?: ReceiptSubmissionAllocation;
}

type ReceiptMutationAuthorizationFor<Target extends ReceiptMutationAuthorizationTarget> =
  Target["_tag"] extends "SubmitReceipt"
    ? Extract<ReceiptMutationAuthorization, { readonly _tag: "SubmitReceipt" }>
    : Exclude<ReceiptMutationAuthorization, { readonly _tag: "SubmitReceipt" }>;

const authorizeReceiptMutationInTransaction = <Target extends ReceiptMutationAuthorizationTarget>(
  target: Target,
  principal: ReceiptCommandPrincipal,
) =>
  Economy.use(({ authorizeReceiptMutation }) => authorizeReceiptMutation(target, principal)).pipe(
    Effect.flatMap((authorization) =>
      authorization._tag === target._tag
        ? Effect.succeed(
            // SAFETY: The service returns the authorization union, and the exact target discriminant is checked above.
            authorization as ReceiptMutationAuthorizationFor<Target>,
          )
        : Effect.fail(
            new ReceiptPersistenceError({
              operation: "authorize Receipt mutation",
              message: "authorization target mismatch",
            }),
          ),
    ),
  );

const executeReceiptMutation = <E, R>(
  prepare: () => Effect.Effect<PreparedReceiptMutation, E, R>,
  execution: { readonly retry?: "serialization-once" } = {},
) =>
  executeNativeHttpCommandPostgres(
    Effect.gen(function* () {
      const prepared = yield* prepare();

      return {
        identity: {
          identitySha256: prepared.identity.identitySha256,
          requestSha256: prepared.requestSha256,
          operationId: prepared.operationId,
        },
        execute: Economy.use(({ executeAuthorizedReceipt }) =>
          Effect.gen(function* () {
            if (prepared.response.status === 200) {
              yield* requireCurrentETag(prepared.response.currentEtag, prepared.response.ifMatch);
            }

            const result = yield* executeAuthorizedReceipt(
              prepared.command,
              prepared.authorization,
              prepared.allocation,
            );

            return receiptMutationCapsule(result.receipt, prepared.response);
          }),
        ),
      };
    }),
    execution,
  );

/** Stages uploaded bytes; bytes past the limit fail validation and any other failure is the store's. */
const stageReceiptFile = (
  fileStore: ReceiptFileStore,
  file: File,
  commandId: string,
  contentType: ReceiptFile["contentType"],
  maxFileBytes: number,
) =>
  fileStore.stageBytes(file, commandId, contentType, maxFileBytes).pipe(
    Effect.catchTag("ReceiptFileStoreError", (cause) =>
      Effect.fail(
        new ReceiptPersistenceError({
          operation: "stage receipt file",
          message: "receipt file staging failed",
          cause,
        }),
      ),
    ),
  );

const cleanupStagedFile = (fileStore: ReceiptFileStore, staged: StagedReceiptFile) =>
  fileStore.cleanupStage(staged.file).pipe(Effect.ignore);

export const submitReceipt = <R>(
  request: Request,
  options: ReceiptApiHttpOptions<ReceiptIdentityFailure, R>,
  fileStore: ReceiptFileStore,
) => {
  let staged: StagedReceiptFile | undefined;
  let allocation: ReceiptSubmissionAllocation | undefined;
  let committed = false;

  return Effect.gen(function* () {
    const departmentId = yield* decodeSubmitQuery(request);
    const fields = yield* decodeSubmitMultipart(request, options.config.maxFileBytes);

    // Failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeReceiptMutation(() =>
      Effect.gen(function* () {
        const principal = yield* authorizationPrincipalInTransaction(request, options);

        const authorization = yield* authorizeReceiptMutationInTransaction(
          ReceiptMutationAuthorizationTarget.SubmitReceipt(
            departmentId === undefined ? {} : { departmentId },
          ),
          principal,
        );

        const identity = yield* mutationIdentity(
          request,
          principal,
          "receipts.submitReceipt",
          "/api/receipts",
        );

        const nextStaged = yield* stageReceiptFile(
          fileStore,
          fields.file,
          identity.commandId,
          fields.contentType,
          options.config.maxFileBytes,
        );

        staged = nextStaged;
        yield* fileStore.service.stage(nextStaged.file);

        const semanticBody: Schema.JsonObject = {
          description: fields.description,
          amountOre: fields.amountOre,
          receiptDate: fields.receiptDate,
          file: {
            contentType: nextStaged.file.contentType,
            byteLength: nextStaged.file.byteLength,
            sha256: nextStaged.file.sha256,
          },
        };

        if (departmentId !== undefined) Object.assign(semanticBody, { departmentId });

        const commandFields = {
          commandId: identity.commandId,
          description: fields.description,
          amountOre: fields.amountOre,
          receiptDate: fields.receiptDate,
          file: nextStaged.file,
        };

        if (departmentId !== undefined) Object.assign(commandFields, { departmentId });

        const command = ReceiptCommandRequestSchema.cases.SubmitReceipt.make(commandFields);

        const nextAllocation = {
          receiptId: ReceiptId.make(options.config.nextReceiptId()),
          visualId: ReceiptVisualId.make(options.config.nextVisualId()),
        };

        allocation = nextAllocation;

        return {
          identity,
          operationId: "receipts.submitReceipt",
          requestSha256: semanticRequestDigest({ body: semanticBody }),
          command,
          authorization,
          response: {
            status: 201,
            location: `/api/receipts/${encodeURIComponent(nextAllocation.receiptId)}`,
          },
          allocation: nextAllocation,
        };
      }),
    );

    if (Predicate.isTagged(outcome, "Committed")) {
      if (allocation === undefined) {
        return yield* new ReceiptPersistenceError({
          operation: "submit receipt allocation",
          message: "transaction preparation produced no allocation",
        });
      }

      committed = true;
      yield* drainReceiptOutbox(options, fileStore, allocation.receiptId);
    } else if (staged?.created === true) {
      yield* cleanupStagedFile(fileStore, staged);
    }

    return yield* commandOutcomeResponse(outcome);
  }).pipe(
    receiptProblems,
    commandReceiptProblems,
    receiptCredentialProblems(personPresentation(request)),
    // A submission names no existing receipt: none is missing, stale, or in another state.
    unreachable("receipt.not-found", "precondition.failed", "receipt.invalid-transition"),
    Effect.ensuring(
      Effect.suspend(() =>
        !committed && staged?.created === true ? cleanupStagedFile(fileStore, staged) : Effect.void,
      ),
    ),
  );
};

export const reviseReceipt = <R>(
  request: Request,
  receiptId: string,
  options: ReceiptApiHttpOptions<ReceiptIdentityFailure, R>,
  fileStore: ReceiptFileStore,
) => {
  let staged: StagedReceiptFile | undefined;
  let committed = false;

  return Effect.gen(function* () {
    const ifMatch = yield* requiredIfMatchOf(request);
    const fields = yield* decodeReviseMultipart(request, options.config.maxFileBytes);

    const outcome = yield* executeReceiptMutation(() =>
      Effect.gen(function* () {
        const principal = yield* authorizationPrincipalInTransaction(request, options);

        const authorization = yield* authorizeReceiptMutationInTransaction(
          ReceiptMutationAuthorizationTarget.RevisePendingReceipt({ receiptId }),
          principal,
        );

        const current = authorization.current;

        const identity = yield* mutationIdentity(
          request,
          principal,
          "receipts.reviseReceipt",
          `/api/receipts/${encodeURIComponent(receiptId)}`,
        );

        if (fields.file !== undefined) {
          const file = fields.file;
          const contentType = fields.contentType;

          if (contentType === undefined) {
            return yield* new ReceiptDecodeError({ message: "invalid receipt file" });
          }

          const nextStaged = yield* stageReceiptFile(
            fileStore,
            file,
            identity.commandId,
            contentType,
            options.config.maxFileBytes,
          );

          staged = nextStaged;
          yield* fileStore.service.stage(nextStaged.file);
        }

        const amountOre = fields.amountOre ?? Number(current.amountOre);

        if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
          return yield* new ReceiptPersistenceError({
            operation: "decode current receipt amount",
            message: "invalid amount",
          });
        }

        const semanticBody: Schema.JsonObject = {};

        if (fields.description !== undefined)
          Object.assign(semanticBody, { description: fields.description });

        if (fields.amountOre !== undefined)
          Object.assign(semanticBody, { amountOre: fields.amountOre });

        if (fields.receiptDate !== undefined)
          Object.assign(semanticBody, { receiptDate: fields.receiptDate });

        if (staged !== undefined)
          Object.assign(semanticBody, {
            file: {
              contentType: staged.file.contentType,
              byteLength: staged.file.byteLength,
              sha256: staged.file.sha256,
            },
          });

        const command = ReceiptCommandRequestSchema.cases.RevisePendingReceipt.make({
          commandId: identity.commandId,
          receiptId: current.receiptId,
          expectedRevision: current.revision,
          description: fields.description ?? current.description,
          amountOre,
          receiptDate: fields.receiptDate ?? current.receiptDate,
          file:
            staged?.file ??
            ReceiptCommandRequestSchema.cases.RevisePendingReceipt.fields.file.members[1].cases.KeepCurrentFile.make(
              {},
            ),
        });

        return {
          identity,
          operationId: "receipts.reviseReceipt",
          requestSha256: semanticRequestDigest(semanticMutationRequest(semanticBody, ifMatch)),
          command,
          authorization,
          response: {
            status: 200,
            ifMatch,
            currentEtag: receiptEtag(receiptId, current.revision),
          },
        };
      }),
    );

    if (Predicate.isTagged(outcome, "Committed")) {
      committed = true;
      yield* drainReceiptOutbox(options, fileStore, receiptId);
    } else if (staged?.created === true) {
      yield* cleanupStagedFile(fileStore, staged);
    }

    return yield* commandOutcomeResponse(outcome);
  }).pipe(
    receiptProblems,
    commandReceiptProblems,
    receiptCredentialProblems(personPresentation(request)),
    // Only a submission allocates a receipt identity that can already exist.
    unreachable("receipt.already-exists"),
    Effect.ensuring(
      Effect.suspend(() =>
        !committed && staged?.created === true ? cleanupStagedFile(fileStore, staged) : Effect.void,
      ),
    ),
  );
};

export const withdrawReceipt = <R>(
  request: Request,
  receiptId: string,
  options: ReceiptApiHttpOptions<ReceiptIdentityFailure, R>,
  fileStore: ReceiptFileStore,
) =>
  Effect.gen(function* () {
    const ifMatch = yield* requiredIfMatchOf(request);
    const body = yield* decodeExactEmptyJson(request);

    const outcome = yield* executeReceiptMutation(() =>
      Effect.gen(function* () {
        const principal = yield* authorizationPrincipalInTransaction(request, options);

        const authorization = yield* authorizeReceiptMutationInTransaction(
          ReceiptMutationAuthorizationTarget.WithdrawPendingReceipt({ receiptId }),
          principal,
        );

        const current = authorization.current;

        const identity = yield* mutationIdentity(
          request,
          principal,
          "receipts.withdrawReceipt",
          `/api/receipts/${encodeURIComponent(receiptId)}/withdraw`,
        );

        return {
          identity,
          operationId: "receipts.withdrawReceipt",
          requestSha256: semanticRequestDigest(semanticMutationRequest(body, ifMatch)),
          command: ReceiptCommandRequestSchema.cases.WithdrawPendingReceipt.make({
            commandId: identity.commandId,
            receiptId: current.receiptId,
            expectedRevision: current.revision,
          }),
          authorization,
          response: {
            status: 200,
            ifMatch,
            currentEtag: receiptEtag(receiptId, current.revision),
          },
        };
      }),
    );

    if (Predicate.isTagged(outcome, "Committed")) {
      yield* drainReceiptOutbox(options, fileStore, receiptId);
    }

    return yield* commandOutcomeResponse(outcome);
  }).pipe(
    receiptProblems,
    commandReceiptProblems,
    receiptCredentialProblems(personPresentation(request)),
    // Only a submission allocates a receipt identity that can already exist.
    unreachable("receipt.already-exists"),
  );

/**
 * A lane the E2E barrier synchronized says so on its answer.
 */
const markSynchronized = (response: Response) => {
  response.headers.set(RECEIPT_E2E_CONCURRENCY_RESPONSE_HEADER, "1");

  return response;
};

/**
 * Approve, reject, or reopen one receipt. Approve and reject join the E2E concurrency barrier
 * when one is composed, and mark synchronized responses, including failures.
 */
export const approvalCommand = <R>(
  request: Request,
  route: ReceiptApprovalRoute,
  options: ReceiptApiHttpOptions<ReceiptIdentityFailure, R>,
  fileStore: ReceiptFileStore,
  barrier: ReceiptE2ETransactionBarrier | undefined,
) => {
  let synchronized = false;

  return Effect.gen(function* () {
    yield* requireNoQuery(request);
    const ifMatch = yield* requiredIfMatchOf(request);
    const body = yield* decodeExactEmptyJson(request);

    const operationId = Match.value(route.action).pipe(
      Match.when("approve", () => "receipts.approveReceipt" as const),
      Match.when("reopen", () => "receipts.reopenReceipt" as const),
      Match.orElse(() => "receipts.rejectReceipt" as const),
    );

    const normalizedTarget = `/api/receipts/${encodeURIComponent(route.receiptId)}/${route.action}`;

    const answer = Effect.gen(function* () {
      const outcome = yield* executeReceiptMutation(
        () =>
          Effect.gen(function* () {
            const principal = yield* authorizationPrincipalInTransaction(request, options);

            if (route.action !== "reopen") {
              synchronized =
                barrier === undefined
                  ? false
                  : yield* barrier(request, route.receiptId, route.action);
            }

            const authorization = yield* authorizeReceiptMutationInTransaction(
              Match.value(route.action).pipe(
                Match.when("approve", () =>
                  ReceiptMutationAuthorizationTarget.ApproveReceipt({ receiptId: route.receiptId }),
                ),
                Match.when("reopen", () =>
                  ReceiptMutationAuthorizationTarget.ReopenRejectedReceipt({
                    receiptId: route.receiptId,
                  }),
                ),
                Match.orElse(() =>
                  ReceiptMutationAuthorizationTarget.RejectReceipt({ receiptId: route.receiptId }),
                ),
              ),
              principal,
            );

            const current = authorization.current;

            const identity = yield* mutationIdentity(
              request,
              principal,
              operationId,
              normalizedTarget,
            );

            return {
              identity,
              operationId,
              requestSha256: semanticRequestDigest(semanticMutationRequest(body, ifMatch)),
              command: Match.value(route.action).pipe(
                Match.when("approve", () =>
                  ReceiptCommandRequestSchema.cases.ApproveReceipt.make({
                    commandId: identity.commandId,
                    receiptId: current.receiptId,
                    expectedRevision: current.revision,
                  }),
                ),
                Match.when("reopen", () =>
                  ReceiptCommandRequestSchema.cases.ReopenRejectedReceipt.make({
                    commandId: identity.commandId,
                    receiptId: current.receiptId,
                    expectedRevision: current.revision,
                  }),
                ),
                Match.orElse(() =>
                  ReceiptCommandRequestSchema.cases.RejectReceipt.make({
                    commandId: identity.commandId,
                    receiptId: current.receiptId,
                    expectedRevision: current.revision,
                  }),
                ),
              ),
              authorization,
              response: {
                status: 200,
                ifMatch,
                currentEtag: receiptEtag(route.receiptId, current.revision),
              },
            };
          }),
        route.action === "reopen" ? {} : { retry: "serialization-once" },
      );

      if (Predicate.isTagged(outcome, "Committed") && route.action !== "reopen") {
        yield* drainReceiptOutbox(options, fileStore, route.receiptId);
      }

      return yield* commandOutcomeResponse(outcome);
    }).pipe(
      receiptProblems,
      commandReceiptProblems,
      receiptCredentialProblems(personPresentation(request)),
      // Only a submission allocates a receipt identity that can already exist.
      unreachable("receipt.already-exists"),
    );

    // A synchronized lane answers its problem itself, so the answer can carry the mark.
    return yield* answer.pipe(
      Effect.map((response) => (synchronized ? markSynchronized(response) : response)),
      Effect.catch((problem) =>
        synchronized
          ? Effect.succeed(markSynchronized(problemWebResponse(problem)))
          : Effect.fail(problem),
      ),
    );
  });
};

export const settleReceipt = <R>(
  request: Request,
  receiptId: ReceiptId,
  options: ReceiptApiHttpOptions<ReceiptIdentityFailure, R>,
  fileStore: ReceiptFileStore,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const ifMatch = yield* requiredIfMatchOf(request);
    const body = yield* decodeSettlementRequest(request);

    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const principal = yield* authorizationPrincipalInTransaction(request, options);

        const revision = yield* Economy.use(({ readReceiptSettlementRevision }) =>
          readReceiptSettlementRevision(receiptId, principal),
        );

        const identity = yield* mutationIdentity(
          request,
          principal,
          "receipts.settleReceipt",
          `/api/receipts/${encodeURIComponent(receiptId)}/settle`,
        );

        const command = yield* decodeRequest(ReceiptSettlementCommandRequestSchema)(
          ReceiptSettlementCommandRequestSchema.cases.RecordReceiptSettlement.make({
            commandId: identity.commandId,
            receiptId,
            expectedRevision: body.expectedRevision,
            externalAuthority: body.externalAuthority,
            externalReference: body.externalReference,
            settledAt: body.settledAt,
          }),
        );

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest(semanticMutationRequest(body, ifMatch)),
            operationId: "receipts.settleReceipt",
          },
          execute: Economy.use(({ recordReceiptSettlement }) =>
            Effect.gen(function* () {
              yield* requireCurrentETag(receiptEtag(receiptId, revision), ifMatch);

              if (body.expectedRevision !== revision) {
                return yield* Problem.make("precondition.failed");
              }

              const result = yield* recordReceiptSettlement(command, principal);

              return settlementMutationCapsule(result.settlement, result.receipt);
            }),
          ),
        };
      }),
      { retry: "serialization-once" },
    );

    if (Predicate.isTagged(outcome, "Committed")) {
      yield* drainReceiptOutbox(options, fileStore, receiptId);
    }

    // Only the settlement evidence is private; an idempotency problem keeps its declared policy.
    const response = yield* commandOutcomeResponse(outcome);
    response.headers.set("cache-control", PRIVATE_NO_STORE);
    response.headers.set("vary", "Origin");

    return response;
  }).pipe(
    receiptProblems,
    commandReceiptProblems,
    receiptCredentialProblems(personPresentation(request)),
  );
