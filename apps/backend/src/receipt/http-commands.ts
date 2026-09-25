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
  type ReceiptMutationAuthorization,
  type ReceiptSubmissionAllocation,
} from "@vektorprogrammet/domain/receipt";
import { Effect, Match, Predicate, Schema } from "effect";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  HttpSemanticFailure,
  deriveHttpIdentity,
  parseIdempotencyKey,
  semanticMutationRequest,
  semanticRequestDigest,
  type NativeIdempotencyIdentity,
} from "../http-semantics.js";
import { nativeCommandOutcomeResponse } from "../native-operation.js";
import {
  RECEIPT_E2E_CONCURRENCY_RESPONSE_HEADER,
  type ReceiptE2ETransactionBarrier,
} from "./e2e-support.js";
import type { ReceiptFileStore, StagedReceiptFile } from "./filesystem.js";
import { authorizationPrincipalInTransaction, type ReceiptApiHttpOptions } from "./http-context.js";
import {
  decodeExactEmptyJson,
  decodeReviseMultipart,
  decodeSettlementRequest,
  decodeSubmitMultipart,
  decodeSubmitQuery,
  headerValues,
  rejectQueryString,
  requiredIfMatch,
} from "./http-decode.js";
import { knownReceiptFailure, publicReceiptErrorResponse } from "./http-problem.js";
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
  Effect.try({
    try: () =>
      deriveHttpIdentity({
        credentialSubject: `Person:${principal.personId}`,
        qualifiedOperationId,
        normalizedTarget,
        idempotencyKey: parseIdempotencyKey(headerValues(request, "idempotency-key")),
      } satisfies NativeIdempotencyIdentity),
    catch: knownReceiptFailure,
  });

interface PreparedReceiptMutation {
  readonly identity: {
    readonly identitySha256: string;
    readonly commandId: string;
  };
  readonly operationId: string;
  readonly requestSha256: string;
  readonly command: ReceiptCommandRequest;
  readonly principal: ReceiptCommandPrincipal;
  readonly authorization: ReceiptMutationAuthorization;
  readonly response: {
    readonly status: 200 | 201;
    readonly location?: string;
    readonly ifMatch?: string;
    readonly currentEtag?: string;
  };
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
            if (
              prepared.response.ifMatch !== undefined &&
              prepared.response.currentEtag !== undefined &&
              prepared.response.ifMatch !== prepared.response.currentEtag
            ) {
              return yield* Effect.fail(new HttpSemanticFailure("precondition.failed", 412));
            }

            const result = yield* executeAuthorizedReceipt(
              prepared.command,
              prepared.authorization,
              prepared.allocation,
            );

            return receiptMutationCapsule(
              result.receipt,
              prepared.response.status,
              prepared.response.location,
            );
          }),
        ),
      };
    }),
    execution,
  );

const cleanupStagedFile = (fileStore: ReceiptFileStore, staged: StagedReceiptFile) =>
  Effect.tryPromise({
    try: () => fileStore.cleanupStage(staged.file),
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.void));

export const submitReceipt = <E, R>(
  request: Request,
  options: ReceiptApiHttpOptions<E, R>,
  fileStore: ReceiptFileStore,
) => {
  let staged: StagedReceiptFile | undefined;
  let allocation: ReceiptSubmissionAllocation | undefined;
  let committed = false;

  return Effect.gen(function* () {
    const departmentId = yield* decodeSubmitQuery(request);
    const fields = yield* decodeSubmitMultipart(request, options.config.maxFileBytes);

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

        const nextStaged = yield* Effect.tryPromise({
          try: () =>
            fileStore.stageBytes(
              fields.file,
              identity.commandId,
              fields.contentType,
              options.config.maxFileBytes,
            ),
          catch: knownReceiptFailure,
        });

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
          principal,
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
        return yield* Effect.fail(
          new ReceiptPersistenceError({
            operation: "submit receipt allocation",
            message: "transaction preparation produced no allocation",
          }),
        );
      }

      committed = true;
      yield* drainReceiptOutbox(options, fileStore, allocation.receiptId);
    } else if (staged?.created === true) {
      yield* cleanupStagedFile(fileStore, staged);
    }

    return nativeCommandOutcomeResponse(outcome);
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        !committed && staged?.created === true ? cleanupStagedFile(fileStore, staged) : Effect.void,
      ),
    ),
  );
};

export const reviseReceipt = <E, R>(
  request: Request,
  receiptId: string,
  options: ReceiptApiHttpOptions<E, R>,
  fileStore: ReceiptFileStore,
) => {
  let staged: StagedReceiptFile | undefined;
  let committed = false;

  return Effect.gen(function* () {
    const ifMatch = yield* requiredIfMatch(request);
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
            return yield* Effect.fail(new ReceiptDecodeError({ message: "invalid receipt file" }));
          }

          const nextStaged = yield* Effect.tryPromise({
            try: () =>
              fileStore.stageBytes(
                file,
                identity.commandId,
                contentType,
                options.config.maxFileBytes,
              ),
            catch: knownReceiptFailure,
          });

          staged = nextStaged;
          yield* fileStore.service.stage(nextStaged.file);
        }

        const amountOre =
          fields.amountOre ??
          (yield* Effect.try({
            try: () => {
              const value = Number(current.amountOre);

              if (!Number.isSafeInteger(value) || value <= 0) {
                throw new ReceiptPersistenceError({
                  operation: "decode current receipt amount",
                  message: "invalid amount",
                });
              }

              return value;
            },
            catch: knownReceiptFailure,
          }));

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
          principal,
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

    return nativeCommandOutcomeResponse(outcome);
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        !committed && staged?.created === true ? cleanupStagedFile(fileStore, staged) : Effect.void,
      ),
    ),
  );
};

export const withdrawReceipt = <E, R>(
  request: Request,
  receiptId: string,
  options: ReceiptApiHttpOptions<E, R>,
  fileStore: ReceiptFileStore,
) =>
  Effect.gen(function* () {
    const ifMatch = yield* requiredIfMatch(request);
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
          principal,
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

    return nativeCommandOutcomeResponse(outcome);
  });

/**
 * Approve, reject, or reopen one receipt. Approve and reject join the E2E concurrency barrier
 * when one is composed, and mark synchronized responses, including failures.
 */
export const approvalCommand = <E, R>(
  request: Request,
  route: ReceiptApprovalRoute,
  options: ReceiptApiHttpOptions<E, R>,
  fileStore: ReceiptFileStore,
  barrier: ReceiptE2ETransactionBarrier | undefined,
) => {
  let synchronized = false;

  return Effect.gen(function* () {
    yield* rejectQueryString(request);
    const ifMatch = yield* requiredIfMatch(request);
    const body = yield* decodeExactEmptyJson(request);

    const operationId = Match.value(route.action).pipe(
      Match.when("approve", () => "receipts.approveReceipt" as const),
      Match.when("reopen", () => "receipts.reopenReceipt" as const),
      Match.orElse(() => "receipts.rejectReceipt" as const),
    );

    const normalizedTarget = `/api/receipts/${encodeURIComponent(route.receiptId)}/${route.action}`;

    const execution = yield* executeReceiptMutation(
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
            principal,
            authorization,
            response: {
              status: 200,
              ifMatch,
              currentEtag: receiptEtag(route.receiptId, current.revision),
            },
          };
        }),
      route.action === "reopen" ? {} : { retry: "serialization-once" },
    ).pipe(
      Effect.match({
        onFailure: (cause) => ({ _tag: "Failure" as const, cause }),
        onSuccess: (outcome) => ({ _tag: "Success" as const, outcome }),
      }),
    );

    if (Predicate.isTagged(execution, "Failure")) {
      if (!synchronized) return yield* Effect.fail(execution.cause);
      const response = publicReceiptErrorResponse(execution.cause);
      response.headers.set(RECEIPT_E2E_CONCURRENCY_RESPONSE_HEADER, "1");

      return response;
    }

    const outcome = execution.outcome;

    if (Predicate.isTagged(outcome, "Committed") && route.action !== "reopen") {
      yield* drainReceiptOutbox(options, fileStore, route.receiptId);
    }

    const response = nativeCommandOutcomeResponse(outcome);

    if (synchronized) response.headers.set(RECEIPT_E2E_CONCURRENCY_RESPONSE_HEADER, "1");

    return response;
  });
};

export const settleReceipt = <E, R>(
  request: Request,
  receiptId: typeof ReceiptId.Type,
  options: ReceiptApiHttpOptions<E, R>,
  fileStore: ReceiptFileStore,
) =>
  Effect.gen(function* () {
    yield* rejectQueryString(request);
    const ifMatch = yield* requiredIfMatch(request);
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

        const command = yield* Schema.decodeUnknownEffect(ReceiptSettlementCommandRequestSchema)(
          ReceiptSettlementCommandRequestSchema.cases.RecordReceiptSettlement.make({
            commandId: identity.commandId,
            receiptId,
            expectedRevision: body.expectedRevision,
            externalAuthority: body.externalAuthority,
            externalReference: body.externalReference,
            settledAt: body.settledAt,
          }),
          { onExcessProperty: "error" },
        ).pipe(
          Effect.mapError(
            () => new ReceiptDecodeError({ message: "invalid receipt settlement command" }),
          ),
        );

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest(semanticMutationRequest(body, ifMatch)),
            operationId: "receipts.settleReceipt",
          },
          execute: Economy.use(({ recordReceiptSettlement }) =>
            Effect.gen(function* () {
              if (
                ifMatch !== receiptEtag(receiptId, revision) ||
                body.expectedRevision !== revision
              ) {
                return yield* Effect.fail(new HttpSemanticFailure("precondition.failed", 412));
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

    const response = nativeCommandOutcomeResponse(outcome);
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("vary", "Origin");

    return response;
  });
