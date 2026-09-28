/**
 * Receipt commands: submit, revise, withdraw, approve, reject, reopen, and settle.
 *
 * Each command resolves the caller's credential inside the serializable transaction that commits
 * it, authorizes the mutation there through `Economy.authorizeReceiptMutation`, compares If-Match
 * with the current entity tag, and stores its answer as a command receipt. The receipt keeps the
 * HTTP route as its normalized target and the HTTP capsule as its answer, so a retry that
 * straddles the cutover replays.
 */
import {
  Economy,
  ReceiptCommandRequestSchema,
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
import {
  type IdempotencyKey,
  RecordReceiptSettlementRequest,
  type ReviseReceiptRequest,
  type SubmitReceiptRequest,
  ReceiptResource,
  ReceiptSettlementEvidenceResource,
} from "@vektorprogrammet/rpc";
import { Problem, type StrongETag } from "@vektorprogrammet/rpc/problem";
import { Effect, Match, Predicate, Schema } from "effect";
import { semanticMutationRequest, semanticRequestDigest } from "../http-semantics.js";
import {
  commandIdentity,
  commandOutcome,
  commandReceiptProblems,
  personPresentation,
  requestInvalid,
  requireCurrentETag,
  unreachable,
} from "../rpc/problem.js";
import { executeNativeHttpCommandPostgres } from "../rpc/receipt-transaction.js";
import { authorizationPrincipalInTransaction, type ReceiptCaller } from "./context.js";
import type { ReceiptE2ETransactionBarrier } from "./e2e-support.js";
import type { ReceiptFileStore, StagedReceiptFile } from "./filesystem.js";
import { drainReceiptOutbox } from "./outbox-drain.js";
import { receiptCredentialProblems, receiptProblems } from "./problem.js";
import {
  receiptEtag,
  receiptMutationCapsule,
  settlementMutationCapsule,
} from "./representation.js";
import {
  type ValidatedReceiptFile,
  validateRevision,
  validateSubmission,
  validateSubmitDepartment,
} from "./validate.js";

export type ReceiptApprovalAction = "approve" | "reject" | "reopen";

/** A command on one existing receipt: its idempotency key and the tag that If-Match names. */
interface ReceiptTransition {
  readonly receiptId: ReceiptId;
  readonly idempotencyKey: IdempotencyKey;
  readonly ifMatch: StrongETag;
}

/** The empty JSON body of the HTTP transitions, which their request digest still covers. */
const emptyBody = {};

const mutationIdentity = (
  principal: ReceiptCommandPrincipal,
  qualifiedOperationId: string,
  normalizedTarget: string,
  idempotencyKey: IdempotencyKey,
) =>
  // The HTTP route stays the normalized target, so receipts and command IDs are stable.
  commandIdentity({
    credentialSubject: `Person:${principal.personId}`,
    qualifiedOperationId,
    normalizedTarget,
    idempotencyKey,
  });

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
            ReceiptPersistenceError.make({
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

            return yield* receiptMutationCapsule({
              receipt: result.receipt,
              response: prepared.response,
            });
          }),
        ),
      };
    }),
    execution,
  );

/** Stages uploaded bytes; any failure of the store is the store's. */
const stageReceiptFile = (
  fileStore: ReceiptFileStore,
  upload: ValidatedReceiptFile,
  commandId: string,
  maxFileBytes: number,
) =>
  fileStore.stageBytes(upload.file, commandId, upload.contentType, maxFileBytes).pipe(
    Effect.catchTag("ReceiptFileStoreError", (cause) =>
      Effect.fail(
        ReceiptPersistenceError.make({
          operation: "stage receipt file",
          message: "receipt file staging failed",
          cause,
        }),
      ),
    ),
  );

const cleanupStagedFile = (fileStore: ReceiptFileStore, staged: StagedReceiptFile) =>
  fileStore.cleanupStage(staged.file).pipe(Effect.ignore);

const semanticFile = (file: ReceiptFile) => ({
  contentType: file.contentType,
  byteLength: file.byteLength,
  sha256: file.sha256,
});

/** The environment of every receipt command: its call and the private receipt store. */
export interface ReceiptCommandContext extends ReceiptCaller {
  readonly fileStore: ReceiptFileStore;
}

export const submitReceipt = ({
  context,
  payload,
}: {
  readonly context: ReceiptCommandContext;
  readonly payload: {
    readonly idempotencyKey: IdempotencyKey;
    readonly departmentId?: string | undefined;
    readonly request: SubmitReceiptRequest;
  };
}) => {
  const { headers, options, fileStore } = context;
  const config = options.config.receipt;
  let staged: StagedReceiptFile | undefined;
  let allocation: ReceiptSubmissionAllocation | undefined;
  let committed = false;

  return Effect.gen(function* () {
    const departmentId = yield* validateSubmitDepartment(payload.departmentId);

    const fields = yield* validateSubmission({
      request: payload.request,
      maxFileBytes: config.maxFileBytes,
    });

    // Failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeReceiptMutation(() =>
      Effect.gen(function* () {
        const principal = yield* authorizationPrincipalInTransaction(context);

        const authorization = yield* authorizeReceiptMutationInTransaction(
          ReceiptMutationAuthorizationTarget.SubmitReceipt(
            departmentId === undefined ? {} : { departmentId },
          ),
          principal,
        );

        const identity = yield* mutationIdentity(
          principal,
          "receipts.submitReceipt",
          "/api/receipts",
          payload.idempotencyKey,
        );

        const nextStaged = yield* stageReceiptFile(
          fileStore,
          fields.file,
          identity.commandId,
          config.maxFileBytes,
        );

        staged = nextStaged;
        yield* fileStore.service.stage(nextStaged.file);

        const semanticFields = {
          description: fields.description,
          amountOre: fields.amountOre,
          receiptDate: fields.receiptDate,
          file: semanticFile(nextStaged.file),
        };

        // The HTTP body named a department only when the query did, and the digest keeps that.
        const semanticBody =
          departmentId === undefined ? semanticFields : { ...semanticFields, departmentId };

        const commandFields = {
          commandId: identity.commandId,
          description: fields.description,
          amountOre: fields.amountOre,
          receiptDate: fields.receiptDate,
          file: nextStaged.file,
        };

        const command = ReceiptCommandRequestSchema.cases.SubmitReceipt.make(
          departmentId === undefined ? commandFields : { ...commandFields, departmentId },
        );

        const nextAllocation = {
          receiptId: ReceiptId.make(config.nextReceiptId()),
          visualId: ReceiptVisualId.make(config.nextVisualId()),
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
        } satisfies PreparedReceiptMutation;
      }),
    );

    if (Predicate.isTagged(outcome, "Committed")) {
      if (allocation === undefined) {
        return yield* ReceiptPersistenceError.make({
          operation: "submit receipt allocation",
          message: "transaction preparation produced no allocation",
        });
      }

      committed = true;
      yield* drainReceiptOutbox({ config }, fileStore, allocation.receiptId);
    } else if (staged?.created === true) {
      yield* cleanupStagedFile(fileStore, staged);
    }

    return yield* commandOutcome(ReceiptResource)(outcome);
  }).pipe(
    receiptProblems,
    commandReceiptProblems,
    receiptCredentialProblems(personPresentation(headers)),
    // A submission names no existing receipt: none is missing, stale, or in another state.
    unreachable("receipt.not-found", "precondition.failed", "receipt.invalid-transition"),
    Effect.ensuring(
      Effect.suspend(() =>
        !committed && staged?.created === true ? cleanupStagedFile(fileStore, staged) : Effect.void,
      ),
    ),
  );
};

export const reviseReceipt = ({
  context,
  payload,
}: {
  readonly context: ReceiptCommandContext;
  readonly payload: {
    readonly receiptId: ReceiptId;
    readonly idempotencyKey: IdempotencyKey;
    readonly ifMatch: StrongETag;
    readonly request: ReviseReceiptRequest;
  };
}) => {
  const { headers, options, fileStore } = context;
  const config = options.config.receipt;
  const { receiptId, ifMatch } = payload;
  let staged: StagedReceiptFile | undefined;
  let committed = false;

  return Effect.gen(function* () {
    const fields = yield* validateRevision({
      request: payload.request,
      maxFileBytes: config.maxFileBytes,
    });

    const outcome = yield* executeReceiptMutation(() =>
      Effect.gen(function* () {
        const principal = yield* authorizationPrincipalInTransaction(context);

        const authorization = yield* authorizeReceiptMutationInTransaction(
          ReceiptMutationAuthorizationTarget.RevisePendingReceipt({ receiptId }),
          principal,
        );

        const current = authorization.current;

        const identity = yield* mutationIdentity(
          principal,
          "receipts.reviseReceipt",
          `/api/receipts/${encodeURIComponent(receiptId)}`,
          payload.idempotencyKey,
        );

        if (fields.file !== undefined) {
          const nextStaged = yield* stageReceiptFile(
            fileStore,
            fields.file,
            identity.commandId,
            config.maxFileBytes,
          );

          staged = nextStaged;
          yield* fileStore.service.stage(nextStaged.file);
        }

        const amountOre = fields.amountOre ?? Number(current.amountOre);

        if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
          return yield* ReceiptPersistenceError.make({
            operation: "decode current receipt amount",
            message: "invalid amount",
          });
        }

        const semanticBody: Record<string, Schema.Json> = {};

        if (fields.description !== undefined) semanticBody.description = fields.description;

        if (fields.amountOre !== undefined) semanticBody.amountOre = fields.amountOre;

        if (fields.receiptDate !== undefined) semanticBody.receiptDate = fields.receiptDate;

        if (staged !== undefined) semanticBody.file = semanticFile(staged.file);

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
            currentEtag: receiptEtag({ receiptId, revision: current.revision }),
          },
        } satisfies PreparedReceiptMutation;
      }),
    );

    if (Predicate.isTagged(outcome, "Committed")) {
      committed = true;
      yield* drainReceiptOutbox({ config }, fileStore, receiptId);
    } else if (staged?.created === true) {
      yield* cleanupStagedFile(fileStore, staged);
    }

    return yield* commandOutcome(ReceiptResource)(outcome);
  }).pipe(
    receiptProblems,
    commandReceiptProblems,
    receiptCredentialProblems(personPresentation(headers)),
    // Only a submission allocates a receipt identity that can already exist.
    unreachable("receipt.already-exists"),
    Effect.ensuring(
      Effect.suspend(() =>
        !committed && staged?.created === true ? cleanupStagedFile(fileStore, staged) : Effect.void,
      ),
    ),
  );
};

export const withdrawReceipt = ({
  context,
  payload,
}: {
  readonly context: ReceiptCommandContext;
  readonly payload: ReceiptTransition;
}) => {
  const { headers, options, fileStore } = context;
  const { receiptId, ifMatch } = payload;

  return Effect.gen(function* () {
    const outcome = yield* executeReceiptMutation(() =>
      Effect.gen(function* () {
        const principal = yield* authorizationPrincipalInTransaction(context);

        const authorization = yield* authorizeReceiptMutationInTransaction(
          ReceiptMutationAuthorizationTarget.WithdrawPendingReceipt({ receiptId }),
          principal,
        );

        const current = authorization.current;

        const identity = yield* mutationIdentity(
          principal,
          "receipts.withdrawReceipt",
          `/api/receipts/${encodeURIComponent(receiptId)}/withdraw`,
          payload.idempotencyKey,
        );

        return {
          identity,
          operationId: "receipts.withdrawReceipt",
          requestSha256: semanticRequestDigest(semanticMutationRequest(emptyBody, ifMatch)),
          command: ReceiptCommandRequestSchema.cases.WithdrawPendingReceipt.make({
            commandId: identity.commandId,
            receiptId: current.receiptId,
            expectedRevision: current.revision,
          }),
          authorization,
          response: {
            status: 200,
            ifMatch,
            currentEtag: receiptEtag({ receiptId, revision: current.revision }),
          },
        } satisfies PreparedReceiptMutation;
      }),
    );

    if (Predicate.isTagged(outcome, "Committed")) {
      yield* drainReceiptOutbox({ config: options.config.receipt }, fileStore, receiptId);
    }

    return yield* commandOutcome(ReceiptResource)(outcome);
  }).pipe(
    receiptProblems,
    commandReceiptProblems,
    receiptCredentialProblems(personPresentation(headers)),
    // Only a submission allocates a receipt identity that can already exist; only a revision
    // decodes fields or stages a file.
    unreachable("receipt.already-exists", "validation.failed", "receipt.file-not-staged"),
  );
};

const approvalOperation = (action: ReceiptApprovalAction) =>
  Match.value(action).pipe(
    Match.when("approve", () => "receipts.approveReceipt" as const),
    Match.when("reopen", () => "receipts.reopenReceipt" as const),
    Match.orElse(() => "receipts.rejectReceipt" as const),
  );

const approvalTarget = (action: ReceiptApprovalAction, receiptId: string) =>
  Match.value(action).pipe(
    Match.when("approve", () => ReceiptMutationAuthorizationTarget.ApproveReceipt({ receiptId })),
    Match.when("reopen", () =>
      ReceiptMutationAuthorizationTarget.ReopenRejectedReceipt({ receiptId }),
    ),
    Match.orElse(() => ReceiptMutationAuthorizationTarget.RejectReceipt({ receiptId })),
  );

const approvalCommandRequest = (
  action: ReceiptApprovalAction,
  fields: {
    readonly commandId: string;
    readonly receiptId: ReceiptId;
    readonly expectedRevision: number;
  },
) =>
  Match.value(action).pipe(
    Match.when("approve", () => ReceiptCommandRequestSchema.cases.ApproveReceipt.make(fields)),
    Match.when("reopen", () =>
      ReceiptCommandRequestSchema.cases.ReopenRejectedReceipt.make(fields),
    ),
    Match.orElse(() => ReceiptCommandRequestSchema.cases.RejectReceipt.make(fields)),
  );

/**
 * Approve, reject, or reopen one receipt. Approve and reject join the E2E concurrency barrier when
 * one is composed.
 */
export const approvalCommand = ({
  context,
  action,
  payload,
  barrier,
}: {
  readonly context: ReceiptCommandContext;
  readonly action: ReceiptApprovalAction;
  readonly payload: ReceiptTransition;
  readonly barrier: ReceiptE2ETransactionBarrier | undefined;
}) => {
  const { headers, options, fileStore } = context;
  const { receiptId, ifMatch } = payload;
  const operationId = approvalOperation(action);
  const normalizedTarget = `/api/receipts/${encodeURIComponent(receiptId)}/${action}`;

  return Effect.gen(function* () {
    const outcome = yield* executeReceiptMutation(
      () =>
        Effect.gen(function* () {
          const principal = yield* authorizationPrincipalInTransaction(context);

          if (action !== "reopen" && barrier !== undefined) {
            yield* barrier(headers, receiptId, action);
          }

          const authorization = yield* authorizeReceiptMutationInTransaction(
            approvalTarget(action, receiptId),
            principal,
          );

          const current = authorization.current;

          const identity = yield* mutationIdentity(
            principal,
            operationId,
            normalizedTarget,
            payload.idempotencyKey,
          );

          return {
            identity,
            operationId,
            requestSha256: semanticRequestDigest(semanticMutationRequest(emptyBody, ifMatch)),
            command: approvalCommandRequest(action, {
              commandId: identity.commandId,
              receiptId: current.receiptId,
              expectedRevision: current.revision,
            }),
            authorization,
            response: {
              status: 200,
              ifMatch,
              currentEtag: receiptEtag({ receiptId, revision: current.revision }),
            },
          } satisfies PreparedReceiptMutation;
        }),
      action === "reopen" ? {} : { retry: "serialization-once" },
    );

    if (Predicate.isTagged(outcome, "Committed") && action !== "reopen") {
      yield* drainReceiptOutbox({ config: options.config.receipt }, fileStore, receiptId);
    }

    return yield* commandOutcome(ReceiptResource)(outcome);
  }).pipe(
    receiptProblems,
    commandReceiptProblems,
    receiptCredentialProblems(personPresentation(headers)),
    // Only a submission allocates a receipt identity that can already exist; only a revision
    // decodes fields or stages a file; a barrier probe that names another lane is a test defect.
    unreachable(
      "receipt.already-exists",
      "validation.failed",
      "receipt.file-not-staged",
      "request.malformed",
    ),
  );
};

export const settleReceipt = ({
  context,
  payload,
}: {
  readonly context: ReceiptCommandContext;
  readonly payload: ReceiptTransition & {
    readonly request: typeof RecordReceiptSettlementRequest.Type;
  };
}) => {
  const { headers, options, fileStore } = context;
  const { receiptId, ifMatch, request: body } = payload;

  return Effect.gen(function* () {
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const principal = yield* authorizationPrincipalInTransaction(context);

        const revision = yield* Economy.use(({ readReceiptSettlementRevision }) =>
          readReceiptSettlementRevision(receiptId, principal),
        );

        const identity = yield* mutationIdentity(
          principal,
          "receipts.settleReceipt",
          `/api/receipts/${encodeURIComponent(receiptId)}/settle`,
          payload.idempotencyKey,
        );

        const command = yield* Schema.decodeEffect(ReceiptSettlementCommandRequestSchema)(
          ReceiptSettlementCommandRequestSchema.cases.RecordReceiptSettlement.make({
            commandId: identity.commandId,
            receiptId,
            expectedRevision: body.expectedRevision,
            externalAuthority: body.externalAuthority,
            externalReference: body.externalReference,
            settledAt: body.settledAt,
          }),
        ).pipe(Effect.mapError(() => requestInvalid()));

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest(semanticMutationRequest({ ...body }, ifMatch)),
            operationId: "receipts.settleReceipt",
          },
          execute: Economy.use(({ recordReceiptSettlement }) =>
            Effect.gen(function* () {
              yield* requireCurrentETag(receiptEtag({ receiptId, revision }), ifMatch);

              if (body.expectedRevision !== revision) {
                return yield* Problem.make("precondition.failed");
              }

              const result = yield* recordReceiptSettlement(command, principal);

              return yield* settlementMutationCapsule({
                settlement: result.settlement,
                receipt: result.receipt,
              });
            }),
          ),
        };
      }),
      { retry: "serialization-once" },
    );

    if (Predicate.isTagged(outcome, "Committed")) {
      yield* drainReceiptOutbox({ config: options.config.receipt }, fileStore, receiptId);
    }

    return yield* commandOutcome(ReceiptSettlementEvidenceResource)(outcome);
  }).pipe(
    receiptProblems,
    commandReceiptProblems,
    receiptCredentialProblems(personPresentation(headers)),
  );
};
