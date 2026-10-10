/**
 * Spike: the receipt lifecycle as one XState machine per command.
 *
 * The machine owns the table of legal transitions: which command each status accepts, the stale
 * revision guard that runs before every status transition, and the refusals as typed failures.
 * Authority is resolved before the command event is sent and stays outside the machine.
 * The only effect is the declared `persistDecision` actor, which needs the transaction-scoped
 * `ReceiptCommandTx` and nothing else. `decideReceipt` in `update.ts` is the oracle of the tests
 * and is not called from here.
 *
 * @since 0.1.0
 */
import { createEffectActor, fromEffect, send, setupEffect, waitFor } from "@xstate/effect";
import { Context, Data, Effect, Predicate, Schema, Struct, flow } from "effect";
import { types } from "xstate";
import { receiptOutboxRequest, sameReceiptFile, type ReceiptOutboxRequest } from "./effects.js";
import {
  InvalidReceiptTransition,
  ReceiptAlreadyExists,
  ReceiptDecodeError,
  ReceiptNotFound,
  StaleReceiptRevision,
  type ReceiptFailure,
} from "./errors.js";
import {
  ReceiptDecisionContextSchema,
  type Receipt,
  type ReceiptFileSelection,
  type ReceiptObservation,
  type ReceiptStatus,
} from "./schema.js";
import {
  AuthorizedReceiptCommandSchema,
  authorizeReceiptMutationAccess,
  type ReceiptDecision,
  type ReceiptDecisionContext,
} from "./update.js";

type ReceiptCommand = typeof AuthorizedReceiptCommandSchema.Type;

type CommandOf<Tag extends ReceiptCommand["_tag"]> = Extract<
  ReceiptCommand,
  { readonly _tag: Tag }
>;

type ExistingReceiptCommand = Exclude<ReceiptCommand, { readonly _tag: "SubmitReceipt" }>;

type DecodedDecisionContext = typeof ReceiptDecisionContextSchema.Type;

/** What one command did: the decision to persist, or the typed failure that refused it. */
export type ReceiptMachineOutcome = Data.TaggedEnum<{
  Decided: { readonly decision: ReceiptDecision };
  Refused: { readonly failure: ReceiptFailure };
}>;

export const ReceiptMachineOutcome = Data.taggedEnum<ReceiptMachineOutcome>();

const { Decided, Refused } = ReceiptMachineOutcome;

export type ReceiptMachineContext = {
  readonly existing: Receipt | undefined;
  readonly decisionContext: DecodedDecisionContext;
  readonly outcome: ReceiptMachineOutcome | undefined;
};

/** `persisting` is entered only with a decision, so its context says so and no branch checks it. */
type PersistingContext = ReceiptMachineContext & {
  readonly outcome: Extract<ReceiptMachineOutcome, { readonly _tag: "Decided" }>;
};

export type ReceiptCommandEvent = {
  [Tag in ReceiptCommand["_tag"]]: { readonly type: Tag; readonly command: CommandOf<Tag> };
}[ReceiptCommand["_tag"]];

/** Wraps a command as the event that the machine accepts; the event type is the command tag. */
export const receiptCommandEvent = (command: ReceiptCommand): ReceiptCommandEvent =>
  AuthorizedReceiptCommandSchema.match<ReceiptCommandEvent>(command, {
    SubmitReceipt: (submit) => ({ type: "SubmitReceipt", command: submit }),
    RevisePendingReceipt: (revise) => ({ type: "RevisePendingReceipt", command: revise }),
    WithdrawPendingReceipt: (withdraw) => ({ type: "WithdrawPendingReceipt", command: withdraw }),
    ApproveReceipt: (approve) => ({ type: "ApproveReceipt", command: approve }),
    RejectReceipt: (reject) => ({ type: "RejectReceipt", command: reject }),
    ReopenRejectedReceipt: (reopen) => ({ type: "ReopenRejectedReceipt", command: reopen }),
  });

/**
 * The only service the machine may require: the transaction that already holds the receipt row.
 * It writes the receipt, the command receipt, the outbox rows, and the audit row of one decision.
 */
export class ReceiptCommandTx extends Context.Service<
  ReceiptCommandTx,
  { readonly record: (decision: ReceiptDecision) => Effect.Effect<void> }
>()("@vektorprogrammet/domain/receipt/ReceiptCommandTx") {}

/** The state that a receipt of each status hydrates into. A new status is a compile error here. */
export const receiptStateOfStatus = {
  Pending: "pending",
  Approved: "approved",
  Rejected: "rejected",
  Withdrawn: "withdrawn",
} as const satisfies Record<ReceiptStatus, string>;

const observation = (commandId: string, receipt: Receipt): ReceiptObservation => ({
  commandId,
  receiptId: receipt.receiptId,
  visualId: receipt.visualId,
  status: receipt.status,
  revision: receipt.revision,
  replayed: false,
});

const isKeepCurrentFile = (
  file: ReceiptFileSelection,
): file is { readonly _tag: "KeepCurrentFile" } =>
  "_tag" in file && Predicate.isTagged(file, "KeepCurrentFile");

// The data rule of each legal edge: a total function of the current receipt and the command.

const submitted = (
  command: CommandOf<"SubmitReceipt">,
  context: DecodedDecisionContext,
): ReceiptDecision => {
  const receipt: Receipt = {
    receiptId: context.receiptId,
    visualId: context.visualId,
    ownerPersonId: command.actor.personId,
    departmentId: command.departmentId,
    amountOre: command.amountOre,
    currency: "NOK",
    description: command.description,
    receiptDate: command.receiptDate,
    submittedAt: context.now,
    status: "Pending",
    approvedAt: null,
    paymentAccountCiphertext: command.paymentAccountCiphertext,
    file: command.file,
    revision: 0,
  };

  return {
    receipt,
    observation: observation(command.commandId, receipt),
    outbox: [
      receiptOutboxRequest(
        command.commandId,
        receipt.receiptId,
        "PromoteReceiptFile",
        receipt.file,
      ),
      receiptOutboxRequest(command.commandId, receipt.receiptId, "NotifyEconomyReceiptSubmitted"),
      receiptOutboxRequest(command.commandId, receipt.receiptId, "WriteReceiptAudit"),
    ],
    auditAction: "ReceiptSubmitted",
  };
};

const revised = (
  current: Receipt,
  command: CommandOf<"RevisePendingReceipt">,
): ReceiptMachineOutcome => {
  const nextFile = isKeepCurrentFile(command.file) ? current.file : command.file;

  const receipt: Receipt = Struct.assign(current, {
    amountOre: command.amountOre,
    description: command.description,
    receiptDate: command.receiptDate,
    file: nextFile,
    revision: current.revision + 1,
  });

  const outbox: ReceiptOutboxRequest[] = [
    receiptOutboxRequest(command.commandId, receipt.receiptId, "WriteReceiptAudit"),
  ];

  if (!sameReceiptFile(current.file, nextFile)) {
    outbox.unshift(
      receiptOutboxRequest(command.commandId, receipt.receiptId, "PromoteReceiptFile", nextFile),
    );
    outbox.push(
      receiptOutboxRequest(command.commandId, receipt.receiptId, "DeleteReceiptFile", current.file),
    );
  }

  return Decided({
    decision: {
      receipt,
      observation: observation(command.commandId, receipt),
      outbox,
      auditAction: "PendingReceiptRevised",
    },
  });
};

const withdrawn = (
  current: Receipt,
  command: CommandOf<"WithdrawPendingReceipt">,
): ReceiptMachineOutcome => {
  const receipt: Receipt = Struct.assign(current, {
    status: "Withdrawn" as const,
    revision: current.revision + 1,
  });

  return Decided({
    decision: {
      receipt,
      observation: observation(command.commandId, receipt),
      outbox: [
        receiptOutboxRequest(
          command.commandId,
          receipt.receiptId,
          "DeleteReceiptFile",
          receipt.file,
        ),
        receiptOutboxRequest(command.commandId, receipt.receiptId, "WriteReceiptAudit"),
      ],
      auditAction: "PendingReceiptWithdrawn",
    },
  });
};

const approved = (
  current: Receipt,
  command: CommandOf<"ApproveReceipt">,
  context: DecodedDecisionContext,
): ReceiptMachineOutcome => {
  const receipt: Receipt = Struct.assign(current, {
    status: "Approved" as const,
    approvedAt: context.now,
    revision: current.revision + 1,
  });

  return Decided({
    decision: {
      receipt,
      observation: observation(command.commandId, receipt),
      outbox: [
        receiptOutboxRequest(command.commandId, receipt.receiptId, "NotifyReceiptApproved"),
        receiptOutboxRequest(command.commandId, receipt.receiptId, "WriteReceiptAudit"),
      ],
      auditAction: "ReceiptApproved",
    },
  });
};

const rejected = (current: Receipt, command: CommandOf<"RejectReceipt">): ReceiptMachineOutcome => {
  const receipt: Receipt = Struct.assign(current, {
    status: "Rejected" as const,
    approvedAt: null,
    revision: current.revision + 1,
  });

  return Decided({
    decision: {
      receipt,
      observation: observation(command.commandId, receipt),
      outbox: [
        receiptOutboxRequest(command.commandId, receipt.receiptId, "NotifyReceiptRejected"),
        receiptOutboxRequest(command.commandId, receipt.receiptId, "WriteReceiptAudit"),
      ],
      auditAction: "ReceiptRejected",
    },
  });
};

const reopened = (
  current: Receipt,
  command: CommandOf<"ReopenRejectedReceipt">,
): ReceiptMachineOutcome => {
  const receipt: Receipt = Struct.assign(current, {
    status: "Pending" as const,
    revision: current.revision + 1,
  });

  return Decided({
    decision: {
      receipt,
      observation: observation(command.commandId, receipt),
      outbox: [],
      auditAction: "RejectedReceiptReopened",
    },
  });
};

// The two exits of every edge: persist the decision, or end in a typed refusal.
const settle = (outcome: ReceiptMachineOutcome) =>
  ReceiptMachineOutcome.$match(outcome, {
    Decided: (decision) => ({ target: "persisting", context: { outcome: decision } }) as const,
    Refused: (refusal) => ({ target: "refused", context: { outcome: refusal } }) as const,
  });

/**
 * An edge for a command on an existing receipt. The guards run in a fixed order, as in
 * `decideReceipt`: no receipt, then a stale revision, then what the edge decides.
 */
const onReceipt =
  <Command extends ExistingReceiptCommand>(
    edge: (
      current: Receipt,
      command: Command,
      context: DecodedDecisionContext,
    ) => ReceiptMachineOutcome,
  ) =>
  ({
    context,
    event,
  }: {
    readonly context: ReceiptMachineContext;
    readonly event: { readonly command: Command };
  }) => {
    const { existing, decisionContext } = context;
    const { command } = event;

    if (existing === undefined) {
      return settle(Refused({ failure: new ReceiptNotFound({ receiptId: command.receiptId }) }));
    }

    if (command.expectedRevision !== existing.revision) {
      return settle(
        Refused({
          failure: new StaleReceiptRevision({
            receiptId: existing.receiptId,
            expected: command.expectedRevision,
            actual: existing.revision,
          }),
        }),
      );
    }

    return settle(edge(existing, command, decisionContext));
  };

const illegal = onReceipt(
  (current: Receipt, command: ExistingReceiptCommand): ReceiptMachineOutcome =>
    Refused({
      failure: new InvalidReceiptTransition({
        receiptId: current.receiptId,
        status: current.status,
        command: command._tag,
      }),
    }),
);

/** Every command is refused until a state lists it as legal. */
const refuseEveryCommand = {
  SubmitReceipt: ({ context }: { readonly context: ReceiptMachineContext }) =>
    settle(
      Refused({
        failure: new ReceiptAlreadyExists({ receiptId: context.decisionContext.receiptId }),
      }),
    ),
  RevisePendingReceipt: illegal,
  WithdrawPendingReceipt: illegal,
  ApproveReceipt: illegal,
  RejectReceipt: illegal,
  ReopenRejectedReceipt: illegal,
};

const persistDecision = fromEffect({
  schemas: { input: types<{ readonly decision: ReceiptDecision }>() },
  effect: ({ input }) => ReceiptCommandTx.use((tx) => tx.record(input.decision)),
});

export const receiptMachine = setupEffect({
  actors: { persistDecision },
  schemas: {
    input: types<{
      readonly existing: Receipt | undefined;
      readonly decisionContext: DecodedDecisionContext;
    }>(),
    context: types<ReceiptMachineContext>(),
    output: types<ReceiptMachineOutcome | undefined>(),
    events: {
      SubmitReceipt: types<{ readonly command: CommandOf<"SubmitReceipt"> }>(),
      RevisePendingReceipt: types<{ readonly command: CommandOf<"RevisePendingReceipt"> }>(),
      WithdrawPendingReceipt: types<{ readonly command: CommandOf<"WithdrawPendingReceipt"> }>(),
      ApproveReceipt: types<{ readonly command: CommandOf<"ApproveReceipt"> }>(),
      RejectReceipt: types<{ readonly command: CommandOf<"RejectReceipt"> }>(),
      ReopenRejectedReceipt: types<{ readonly command: CommandOf<"ReopenRejectedReceipt"> }>(),
    },
  },
  states: { persisting: { schemas: { context: types<PersistingContext>() } } },
}).createMachine({
  id: "ReceiptCommand",
  context: ({ input }) => ({
    existing: input.existing,
    decisionContext: input.decisionContext,
    outcome: undefined,
  }),
  initial: "hydrating",
  output: ({ context }) => context.outcome,
  states: {
    hydrating: {
      always: ({ context }) => ({
        target:
          context.existing === undefined ? "absent" : receiptStateOfStatus[context.existing.status],
      }),
    },
    absent: {
      on: {
        ...refuseEveryCommand,
        SubmitReceipt: ({ context, event }) =>
          settle(Decided({ decision: submitted(event.command, context.decisionContext) })),
      },
    },
    pending: {
      on: {
        ...refuseEveryCommand,
        RevisePendingReceipt: onReceipt(revised),
        WithdrawPendingReceipt: onReceipt(withdrawn),
        ApproveReceipt: onReceipt(approved),
        RejectReceipt: onReceipt(rejected),
      },
    },
    approved: { on: refuseEveryCommand },
    rejected: { on: { ...refuseEveryCommand, ReopenRejectedReceipt: onReceipt(reopened) } },
    withdrawn: { on: refuseEveryCommand },
    persisting: {
      invoke: {
        src: "persistDecision",
        input: ({ context }) => ({ decision: context.outcome.decision }),
        onDone: { target: "decided" },
      },
    },
    decided: { type: "final" },
    refused: { type: "final" },
  },
});

const decodeReceiptCommand = flow(
  Schema.decodeUnknownEffect(AuthorizedReceiptCommandSchema, { onExcessProperty: "error" }),
  Effect.mapError((cause) => new ReceiptDecodeError({ message: String(cause) })),
);

const decodeReceiptDecisionContext = flow(
  Schema.decodeUnknownEffect(ReceiptDecisionContextSchema, { onExcessProperty: "error" }),
  Effect.mapError((cause) => new ReceiptDecodeError({ message: String(cause) })),
);

// `ReceiptAccessAuthorization` of `update.ts` is not exported, so its constructors derive from the
// exported function that takes it.
const ReceiptAccessAuthorization =
  Data.taggedEnum<Parameters<typeof authorizeReceiptMutationAccess>[0]>();

/**
 * Authority stays outside the machine, with the guards of `decideReceipt` in the same order.
 * A command on an absent receipt has no authority to resolve: the machine refuses it as not found.
 */
const authorize = (
  existing: Receipt | undefined,
  command: ReceiptCommand,
): Effect.Effect<void, ReceiptFailure> => {
  if (Predicate.isTagged(command, "SubmitReceipt")) {
    return authorizeReceiptMutationAccess(
      ReceiptAccessAuthorization.SubmitReceipt({
        actor: command.actor,
        departmentId: command.departmentId,
      }),
    );
  }

  if (existing === undefined) return Effect.void;

  return authorizeReceiptMutationAccess(
    ReceiptAccessAuthorization[command._tag]({ actor: command.actor, current: existing }),
  );
};

/**
 * Runs one command through its own actor. Decoding and authority come first; the machine decides
 * and persists through `ReceiptCommandTx`; a refusal is the typed failure of `decideReceipt`.
 */
export const runReceiptCommand = Effect.fn("runReceiptCommand")(function* (
  existing: Receipt | undefined,
  input: Schema.Json,
  context: ReceiptDecisionContext,
): Effect.fn.Return<ReceiptDecision, ReceiptFailure, ReceiptCommandTx> {
  const command = yield* decodeReceiptCommand(input);
  const decisionContext = yield* decodeReceiptDecisionContext(context);
  yield* authorize(existing, command);

  const outcome = yield* Effect.gen(function* () {
    const actor = yield* createEffectActor(receiptMachine, {
      input: { existing, decisionContext },
    });

    yield* send(actor, receiptCommandEvent(command));

    // `join` fails with `unknown`, which the house rule `any-unknown-in-error-context` rejects.
    // `waitFor` fails with the typed `ActorStoppedError`, and an errored actor is a defect here;
    // the defect keeps the error that the actor failed with, which the stopped error only carries.
    const finished = yield* waitFor(actor, (snapshot) => snapshot.status === "done").pipe(
      Effect.catchTag("ActorStoppedError", (stopped) =>
        Effect.die(stopped.snapshot.error ?? stopped),
      ),
    );

    return finished.output;
  }).pipe(Effect.scoped);

  if (outcome === undefined) {
    return yield* Effect.die("The receipt machine completed without an outcome");
  }

  return yield* ReceiptMachineOutcome.$match(outcome, {
    Decided: ({ decision }) => Effect.succeed(decision),
    Refused: ({ failure }) => Effect.fail(failure),
  });
});
