import { Effect, Schema } from "effect";
import {
  InactiveActor,
  InvalidReceiptTransition,
  ReceiptAlreadyExists,
  ReceiptDecodeError,
  ReceiptNotFound,
  ReceiptOwnerDenied,
  ReceiptScopeDenied,
  StaleReceiptRevision,
  type ReceiptFailure,
} from "./errors.js";
import { makeReceiptOutboxRequest, sameReceiptFile, type ReceiptOutboxRequest } from "./effects.js";
import {
  ReceiptCommandSchema,
  ReceiptDecisionContextSchema,
  ReceiptId,
  ReceiptVisualId,
  type Receipt,
  type ReceiptActor,
  type ReceiptCommand,
  type ReceiptFileSelection,
  type ReceiptObservation,
} from "./schema.js";

export interface ReceiptDecisionContext {
  readonly receiptId: string;
  readonly visualId: string;
  readonly now: string;
}

export type { ReceiptOutboxRequest } from "./effects.js";

export interface ReceiptDecision {
  readonly receipt: Receipt;
  readonly observation: ReceiptObservation;
  readonly outbox: ReadonlyArray<ReceiptOutboxRequest>;
  readonly auditAction: string;
}

const activeActor = (actor: ReceiptActor): Effect.Effect<void, InactiveActor> =>
  actor.active ? Effect.void : Effect.fail(new InactiveActor({ personId: actor.personId }));

const requireReceipt = (
  receipt: Receipt | undefined,
  receiptId: string,
): Effect.Effect<Receipt, ReceiptNotFound> =>
  receipt === undefined ? Effect.fail(new ReceiptNotFound({ receiptId })) : Effect.succeed(receipt);

const currentRevision = (
  receipt: Receipt,
  expected: number,
): Effect.Effect<void, StaleReceiptRevision> =>
  receipt.revision === expected
    ? Effect.void
    : Effect.fail(
        new StaleReceiptRevision({
          receiptId: receipt.receiptId,
          expected,
          actual: receipt.revision,
        }),
      );

const pending = (
  receipt: Receipt,
  command: string,
): Effect.Effect<void, InvalidReceiptTransition> =>
  receipt.status === "Pending"
    ? Effect.void
    : Effect.fail(
        new InvalidReceiptTransition({
          receiptId: receipt.receiptId,
          status: receipt.status,
          command,
        }),
      );

const owner = (receipt: Receipt, actor: ReceiptActor): Effect.Effect<void, ReceiptOwnerDenied> =>
  receipt.ownerPersonId === actor.personId
    ? Effect.void
    : Effect.fail(
        new ReceiptOwnerDenied({
          receiptId: receipt.receiptId,
          personId: actor.personId,
        }),
      );

const approver = (
  receipt: Receipt,
  actor: ReceiptActor,
): Effect.Effect<void, ReceiptScopeDenied> => {
  const allowed =
    actor.approvalScope._tag === "Global" ||
    (actor.approvalScope._tag === "Department" &&
      actor.approvalScope.departmentId === receipt.departmentId);
  return allowed
    ? Effect.void
    : Effect.fail(
        new ReceiptScopeDenied({
          receiptId: receipt.receiptId,
          departmentId: receipt.departmentId,
        }),
      );
};

const observation = (commandId: string, receipt: Receipt): ReceiptObservation => ({
  commandId,
  receiptId: receipt.receiptId,
  visualId: receipt.visualId,
  status: receipt.status,
  revision: receipt.revision,
  replayed: false,
});

const effect = makeReceiptOutboxRequest;
type KeepCurrentFileSelection = Extract<ReceiptFileSelection, { readonly _tag: "KeepCurrentFile" }>;

const isKeepCurrentFile = (file: ReceiptFileSelection): file is KeepCurrentFileSelection =>
  "_tag" in file && file._tag === "KeepCurrentFile";

const decideCommand = (
  existing: Receipt | undefined,
  command: ReceiptCommand,
  context: ReceiptDecisionContext,
): Effect.Effect<ReceiptDecision, ReceiptFailure> =>
  Effect.gen(function* () {
    yield* activeActor(command.actor);

    return yield* ReceiptCommandSchema.match<Effect.Effect<ReceiptDecision, ReceiptFailure>>(
      command,
      {
        SubmitReceipt: (input) =>
          Effect.gen(function* () {
            if (existing !== undefined) {
              return yield* new ReceiptAlreadyExists({ receiptId: context.receiptId });
            }
            if (input.actor.departmentId !== input.departmentId) {
              return yield* new ReceiptScopeDenied({
                receiptId: context.receiptId,
                departmentId: input.departmentId,
              });
            }
            const receipt: Receipt = {
              receiptId: ReceiptId.make(context.receiptId),
              visualId: ReceiptVisualId.make(context.visualId),
              ownerPersonId: input.actor.personId,
              departmentId: input.departmentId,
              amountOre: input.amountOre,
              currency: "NOK",
              description: input.description,
              receiptDate: input.receiptDate,
              submittedAt: context.now,
              status: "Pending",
              refundDate: null,
              paymentAccountCiphertext: input.paymentAccountCiphertext,
              file: input.file,
              revision: 0,
            };
            return {
              receipt,
              observation: observation(input.commandId, receipt),
              outbox: [
                effect(input.commandId, receipt.receiptId, "PromoteReceiptFile", receipt.file),
                effect(input.commandId, receipt.receiptId, "NotifyEconomyReceiptSubmitted"),
                effect(input.commandId, receipt.receiptId, "WriteReceiptAudit"),
              ],
              auditAction: "ReceiptSubmitted",
            };
          }),
        RevisePendingReceipt: (input) =>
          Effect.gen(function* () {
            const current = yield* requireReceipt(existing, input.receiptId);
            yield* owner(current, input.actor);
            yield* currentRevision(current, input.expectedRevision);
            yield* pending(current, input._tag);
            const nextFile = isKeepCurrentFile(input.file) ? current.file : input.file;
            const receipt: Receipt = {
              ...current,
              amountOre: input.amountOre,
              description: input.description,
              receiptDate: input.receiptDate,
              file: nextFile,
              revision: current.revision + 1,
            };
            const outbox: ReceiptOutboxRequest[] = [
              effect(input.commandId, receipt.receiptId, "WriteReceiptAudit"),
            ];
            if (!sameReceiptFile(current.file, nextFile)) {
              outbox.unshift(
                effect(input.commandId, receipt.receiptId, "PromoteReceiptFile", nextFile),
              );
              outbox.push(
                effect(input.commandId, receipt.receiptId, "DeleteReceiptFile", current.file),
              );
            }
            return {
              receipt,
              observation: observation(input.commandId, receipt),
              outbox,
              auditAction: "PendingReceiptRevised",
            };
          }),
        WithdrawPendingReceipt: (input) =>
          Effect.gen(function* () {
            const current = yield* requireReceipt(existing, input.receiptId);
            yield* owner(current, input.actor);
            yield* currentRevision(current, input.expectedRevision);
            yield* pending(current, input._tag);
            const receipt: Receipt = {
              ...current,
              status: "Withdrawn",
              revision: current.revision + 1,
            };
            return {
              receipt,
              observation: observation(input.commandId, receipt),
              outbox: [
                effect(input.commandId, receipt.receiptId, "DeleteReceiptFile", receipt.file),
                effect(input.commandId, receipt.receiptId, "WriteReceiptAudit"),
              ],
              auditAction: "PendingReceiptWithdrawn",
            };
          }),
        RefundReceipt: (input) =>
          Effect.gen(function* () {
            const current = yield* requireReceipt(existing, input.receiptId);
            yield* approver(current, input.actor);
            yield* currentRevision(current, input.expectedRevision);
            yield* pending(current, input._tag);
            const receipt: Receipt = {
              ...current,
              status: "Refunded",
              refundDate: context.now,
              revision: current.revision + 1,
            };
            return {
              receipt,
              observation: observation(input.commandId, receipt),
              outbox: [
                effect(input.commandId, receipt.receiptId, "NotifyReceiptRefunded"),
                effect(input.commandId, receipt.receiptId, "WriteReceiptAudit"),
              ],
              auditAction: "ReceiptRefunded",
            };
          }),
        RejectReceipt: (input) =>
          Effect.gen(function* () {
            const current = yield* requireReceipt(existing, input.receiptId);
            yield* approver(current, input.actor);
            yield* currentRevision(current, input.expectedRevision);
            yield* pending(current, input._tag);
            const receipt: Receipt = {
              ...current,
              status: "Rejected",
              refundDate: null,
              revision: current.revision + 1,
            };
            return {
              receipt,
              observation: observation(input.commandId, receipt),
              outbox: [
                effect(input.commandId, receipt.receiptId, "NotifyReceiptRejected"),
                effect(input.commandId, receipt.receiptId, "WriteReceiptAudit"),
              ],
              auditAction: "ReceiptRejected",
            };
          }),
      },
    );
  });

export const decodeReceiptCommand = (
  input: unknown,
): Effect.Effect<ReceiptCommand, ReceiptDecodeError> =>
  Schema.decodeUnknownEffect(ReceiptCommandSchema)(input, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError((cause) => new ReceiptDecodeError({ message: String(cause) })));

const decodeReceiptDecisionContext = (
  input: unknown,
): Effect.Effect<ReceiptDecisionContext, ReceiptDecodeError> =>
  Schema.decodeUnknownEffect(ReceiptDecisionContextSchema)(input, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError((cause) => new ReceiptDecodeError({ message: String(cause) })));

export const decideReceipt = (
  existing: Receipt | undefined,
  input: unknown,
  context: ReceiptDecisionContext,
): Effect.Effect<ReceiptDecision, ReceiptFailure> =>
  decodeReceiptCommand(input).pipe(
    Effect.flatMap((command) =>
      decodeReceiptDecisionContext(context).pipe(
        Effect.flatMap((decodedContext) => decideCommand(existing, command, decodedContext)),
      ),
    ),
  );
