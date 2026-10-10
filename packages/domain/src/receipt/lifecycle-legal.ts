/**
 * Spike 2: the receipt lifecycle as one XState machine per command, with legal edges only.
 *
 * Each state lists the commands that are legal in it and no others: `absent` accepts
 * `SubmitReceipt`, `pending` the four commands on a pending receipt, `rejected`
 * `ReopenRejectedReceipt`, and `approved` and `withdrawn` accept nothing. There is no refusal edge
 * and no wildcard. So the machine is the one table of legal transitions, and `snapshot.can` and
 * `getNextTransitions` read it.
 *
 * The runner turns "the hydrated state does not list this command" into the typed failure of
 * `decideReceipt`. It asks the machine and does not repeat which status lists which command. What
 * it keeps are preconditions that come from the shape of a command, and they run in the order of
 * `decideReceipt`: the receipt exists (every command but `SubmitReceipt` acts on one and needs it to
 * authorize), authority, the revision, then legality. Authority and the revision do not depend on
 * the status, so they are not part of what a state accepts. The revision check must also run for a
 * command that the state does not list (`StaleReceiptRevision` comes before
 * `InvalidReceiptTransition`), and such a command has no edge to carry a guard.
 *
 * The only effect is the declared `persistDecision` actor of spike 1, which needs the
 * transaction-scoped `ReceiptCommandTx` and nothing else. `decideReceipt` in `update.ts` is the
 * oracle of the tests and is not called from here.
 *
 * @since 0.1.0
 */
import { createEffectActor, fromEffect, send, setupEffect, waitFor } from "@xstate/effect";
import { Data, Effect, Match, Predicate, Schema, Struct, flow } from "effect";
import { initialTransition, types } from "xstate";
import { receiptOutboxRequest, sameReceiptFile, type ReceiptOutboxRequest } from "./effects.js";
import {
  InvalidReceiptTransition,
  ReceiptAlreadyExists,
  ReceiptDecodeError,
  ReceiptNotFound,
  StaleReceiptRevision,
  type ReceiptFailure,
} from "./errors.js";
import { ReceiptCommandTx, ReceiptMachineOutcome, receiptCommandEvent } from "./lifecycle.js";
import {
  ReceiptDecisionContextSchema,
  type Receipt,
  type ReceiptFileSelection,
  type ReceiptObservation,
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

/** A machine with no refusal has one outcome: the decision that it persists. */
type DecidedOutcome = Extract<ReceiptMachineOutcome, { readonly _tag: "Decided" }>;

const { Decided } = ReceiptMachineOutcome;

type LegalContext = {
  readonly existing: Receipt | undefined;
  readonly decisionContext: DecodedDecisionContext;
  readonly outcome: DecidedOutcome | undefined;
};

/** `pending` and `rejected` are entered only for a receipt that exists, so their edges need no branch. */
type HydratedContext = LegalContext & { readonly existing: Receipt };

/** `persisting` is entered only with a decision, so its context says so and no branch checks it. */
type PersistingContext = LegalContext & { readonly outcome: DecidedOutcome };

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
// They are the rules of spike 1, which keeps them private, with the decision as the result.

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

const revised = (current: Receipt, command: CommandOf<"RevisePendingReceipt">): ReceiptDecision => {
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

  return {
    receipt,
    observation: observation(command.commandId, receipt),
    outbox,
    auditAction: "PendingReceiptRevised",
  };
};

const withdrawn = (
  current: Receipt,
  command: CommandOf<"WithdrawPendingReceipt">,
): ReceiptDecision => {
  const receipt: Receipt = Struct.assign(current, {
    status: "Withdrawn" as const,
    revision: current.revision + 1,
  });

  return {
    receipt,
    observation: observation(command.commandId, receipt),
    outbox: [
      receiptOutboxRequest(command.commandId, receipt.receiptId, "DeleteReceiptFile", receipt.file),
      receiptOutboxRequest(command.commandId, receipt.receiptId, "WriteReceiptAudit"),
    ],
    auditAction: "PendingReceiptWithdrawn",
  };
};

const approved = (
  current: Receipt,
  command: CommandOf<"ApproveReceipt">,
  context: DecodedDecisionContext,
): ReceiptDecision => {
  const receipt: Receipt = Struct.assign(current, {
    status: "Approved" as const,
    approvedAt: context.now,
    revision: current.revision + 1,
  });

  return {
    receipt,
    observation: observation(command.commandId, receipt),
    outbox: [
      receiptOutboxRequest(command.commandId, receipt.receiptId, "NotifyReceiptApproved"),
      receiptOutboxRequest(command.commandId, receipt.receiptId, "WriteReceiptAudit"),
    ],
    auditAction: "ReceiptApproved",
  };
};

const rejected = (current: Receipt, command: CommandOf<"RejectReceipt">): ReceiptDecision => {
  const receipt: Receipt = Struct.assign(current, {
    status: "Rejected" as const,
    approvedAt: null,
    revision: current.revision + 1,
  });

  return {
    receipt,
    observation: observation(command.commandId, receipt),
    outbox: [
      receiptOutboxRequest(command.commandId, receipt.receiptId, "NotifyReceiptRejected"),
      receiptOutboxRequest(command.commandId, receipt.receiptId, "WriteReceiptAudit"),
    ],
    auditAction: "ReceiptRejected",
  };
};

const reopened = (
  current: Receipt,
  command: CommandOf<"ReopenRejectedReceipt">,
): ReceiptDecision => {
  const receipt: Receipt = Struct.assign(current, {
    status: "Pending" as const,
    revision: current.revision + 1,
  });

  return {
    receipt,
    observation: observation(command.commandId, receipt),
    outbox: [],
    auditAction: "RejectedReceiptReopened",
  };
};

/** A legal edge always ends in `persisting` with the decision that its rule computed. */
const legalEdge = <Command extends ExistingReceiptCommand>(
  rule: (current: Receipt, command: Command, context: DecodedDecisionContext) => ReceiptDecision,
) =>
  ({
    target: "persisting",
    context: ({
      context,
      event,
    }: {
      readonly context: HydratedContext;
      readonly event: { readonly command: Command };
    }) => ({
      outcome: Decided({
        decision: rule(context.existing, event.command, context.decisionContext),
      }),
    }),
  }) as const;

const persistDecision = fromEffect({
  schemas: { input: types<{ readonly decision: ReceiptDecision }>() },
  effect: ({ input }) => ReceiptCommandTx.use((tx) => tx.record(input.decision)),
});

export const receiptLegalMachine = setupEffect({
  actors: { persistDecision },
  schemas: {
    input: types<{
      readonly existing: Receipt | undefined;
      readonly decisionContext: DecodedDecisionContext;
    }>(),
    context: types<LegalContext>(),
    output: types<DecidedOutcome | undefined>(),
    events: {
      SubmitReceipt: types<{ readonly command: CommandOf<"SubmitReceipt"> }>(),
      RevisePendingReceipt: types<{ readonly command: CommandOf<"RevisePendingReceipt"> }>(),
      WithdrawPendingReceipt: types<{ readonly command: CommandOf<"WithdrawPendingReceipt"> }>(),
      ApproveReceipt: types<{ readonly command: CommandOf<"ApproveReceipt"> }>(),
      RejectReceipt: types<{ readonly command: CommandOf<"RejectReceipt"> }>(),
      ReopenRejectedReceipt: types<{ readonly command: CommandOf<"ReopenRejectedReceipt"> }>(),
    },
  },
  states: {
    pending: { schemas: { context: types<HydratedContext>() } },
    rejected: { schemas: { context: types<HydratedContext>() } },
    persisting: { schemas: { context: types<PersistingContext>() } },
  },
}).createMachine({
  id: "ReceiptCommandLegal",
  context: ({ input }) => ({
    existing: input.existing,
    decisionContext: input.decisionContext,
    outcome: undefined,
  }),
  initial: "hydrating",
  output: ({ context }) => context.outcome,
  states: {
    hydrating: {
      always: ({ context }) => {
        const { existing } = context;

        if (existing === undefined) return { target: "absent" } as const;

        return Match.value(existing.status).pipe(
          Match.when("Pending", () => ({ target: "pending", context: { existing } }) as const),
          Match.when("Approved", () => ({ target: "approved" }) as const),
          Match.when("Rejected", () => ({ target: "rejected", context: { existing } }) as const),
          Match.when("Withdrawn", () => ({ target: "withdrawn" }) as const),
          Match.exhaustive,
        );
      },
    },
    absent: {
      on: {
        SubmitReceipt: {
          target: "persisting",
          context: ({ context, event }) => ({
            outcome: Decided({ decision: submitted(event.command, context.decisionContext) }),
          }),
        },
      },
    },
    pending: {
      on: {
        RevisePendingReceipt: legalEdge(revised),
        WithdrawPendingReceipt: legalEdge(withdrawn),
        ApproveReceipt: legalEdge(approved),
        RejectReceipt: legalEdge(rejected),
      },
    },
    approved: {},
    rejected: { on: { ReopenRejectedReceipt: legalEdge(reopened) } },
    withdrawn: {},
    persisting: {
      invoke: {
        src: "persistDecision",
        input: ({ context }) => ({ decision: context.outcome.decision }),
        onDone: { target: "decided" },
      },
    },
    decided: { type: "final" },
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
 * Runs one command through its own actor. The refusals come first and in the order of
 * `decideReceipt`; only the legality of the command is read from the machine, through the snapshot
 * that the receipt hydrates. A command that the state lists then runs: the machine decides and
 * persists through `ReceiptCommandTx`.
 *
 * The check before `send` is required. An event that the state does not list is dropped, so the
 * actor would stay active and `waitFor` would never return.
 */
export const runReceiptCommandLegal = Effect.fn("runReceiptCommandLegal")(function* (
  existing: Receipt | undefined,
  input: Schema.Json,
  context: ReceiptDecisionContext,
): Effect.fn.Return<ReceiptDecision, ReceiptFailure, ReceiptCommandTx> {
  const command = yield* decodeReceiptCommand(input);
  const decisionContext = yield* decodeReceiptDecisionContext(context);
  const event = receiptCommandEvent(command);
  const [hydrated] = initialTransition(receiptLegalMachine, { existing, decisionContext });

  if (Predicate.isTagged(command, "SubmitReceipt")) {
    yield* authorizeReceiptMutationAccess(
      ReceiptAccessAuthorization.SubmitReceipt({
        actor: command.actor,
        departmentId: command.departmentId,
      }),
    );

    // The creating command that the state does not list met a receipt that already exists.
    if (!hydrated.can(event)) {
      return yield* new ReceiptAlreadyExists({ receiptId: decisionContext.receiptId });
    }
  } else {
    if (existing === undefined) {
      return yield* new ReceiptNotFound({ receiptId: command.receiptId });
    }

    yield* authorizeReceiptMutationAccess(
      ReceiptAccessAuthorization[command._tag]({ actor: command.actor, current: existing }),
    );

    if (command.expectedRevision !== existing.revision) {
      return yield* new StaleReceiptRevision({
        receiptId: existing.receiptId,
        expected: command.expectedRevision,
        actual: existing.revision,
      });
    }

    // Every other command that the state does not list is an invalid transition of the receipt.
    if (!hydrated.can(event)) {
      return yield* new InvalidReceiptTransition({
        receiptId: existing.receiptId,
        status: existing.status,
        command: command._tag,
      });
    }
  }

  const outcome = yield* Effect.gen(function* () {
    const actor = yield* createEffectActor(receiptLegalMachine, {
      input: { existing, decisionContext },
    });

    yield* send(actor, event);

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

  return outcome.decision;
});
