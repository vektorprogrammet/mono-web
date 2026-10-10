import { fromEffect, setupEffect, type RequirementsFrom } from "@xstate/effect";
import { assert, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Ref,
  Result,
  Schema,
  Struct,
} from "effect";
import {
  getInitialMicrosteps,
  getNextTransitions,
  initialTransition,
  isUnhandled,
  transition,
  type AnyEventObject,
  type AnyStateMachine,
  type DoneActorEvent,
} from "xstate";
import { getAllOwnEvents, getShortestPaths } from "xstate/graph";
import { expectTypeOf } from "vitest";
import { Scope } from "../authz/access.js";
import { DepartmentId, PersonId } from "../organization/schema.js";
import type { ReceiptFailure } from "./errors.js";
import {
  ReceiptCommandTx,
  receiptCommandEvent,
  receiptMachine,
  receiptStateOfStatus,
} from "./lifecycle.js";
import { receiptLegalMachine, runReceiptCommandLegal } from "./lifecycle-legal.js";
import {
  ApprovalScopeSchema,
  ReceiptId,
  ReceiptStatusSchema,
  ReceiptVisualId,
  type Receipt,
  type ReceiptActor,
  type ReceiptFile,
  type ReceiptFileSelection,
  type ReceiptStatus,
} from "./schema.js";
import { AuthorizedReceiptCommandSchema, decideReceipt, type ReceiptDecision } from "./update.js";

type ReceiptCommand = typeof AuthorizedReceiptCommandSchema.Type;

const commandKinds = [
  "SubmitReceipt",
  "RevisePendingReceipt",
  "WithdrawPendingReceipt",
  "ApproveReceipt",
  "RejectReceipt",
  "ReopenRejectedReceipt",
] as const;

type CommandKind = (typeof commandKinds)[number];

// "fitting" is the actor that the command needs: an owner for the owner commands, an approver for
// the others. The other kinds are the denied and the inactive actors.
const actorKinds = [
  "fitting",
  "owner",
  "approver",
  "inactiveOwner",
  "otherDepartmentApprover",
] as const;

const revisionKinds = ["current", "behind", "ahead"] as const;

const fileKinds = ["keep", "same", "replacement"] as const;

const startKinds = ["absent", "pending", "approved", "rejected", "withdrawn"] as const;

type StartKind = (typeof startKinds)[number];

type ActorKind = Exclude<(typeof actorKinds)[number], "fitting">;

const department = DepartmentId.make("lifecycle-department");

const otherDepartment = DepartmentId.make("lifecycle-other-department");

const receiptId = ReceiptId.make("lifecycle-receipt");

const actors = {
  owner: {
    personId: PersonId.make("lifecycle-owner"),
    departmentId: department,
    active: true,
    approvalScope: ApprovalScopeSchema.cases.None.make({}),
  },
  approver: {
    personId: PersonId.make("lifecycle-approver"),
    departmentId: department,
    active: true,
    approvalScope: Scope.Department({ departmentId: department }),
  },
  inactiveOwner: {
    personId: PersonId.make("lifecycle-inactive-owner"),
    departmentId: department,
    active: false,
    approvalScope: ApprovalScopeSchema.cases.None.make({}),
  },
  otherDepartmentApprover: {
    personId: PersonId.make("lifecycle-other-department-approver"),
    departmentId: otherDepartment,
    active: true,
    approvalScope: Scope.Department({ departmentId: otherDepartment }),
  },
} satisfies Record<ActorKind, ReceiptActor>;

const fittingActor = {
  SubmitReceipt: "owner",
  RevisePendingReceipt: "owner",
  WithdrawPendingReceipt: "owner",
  ApproveReceipt: "approver",
  RejectReceipt: "approver",
  ReopenRejectedReceipt: "approver",
} as const satisfies Record<CommandKind, ActorKind>;

const baseFile: ReceiptFile = {
  fileRef: "staged/lifecycle-file",
  objectKey: "receipts/lifecycle-file",
  contentType: "application/pdf",
  byteLength: 128,
  sha256: "a".repeat(64),
};

const keepCurrentFile =
  AuthorizedReceiptCommandSchema.cases.RevisePendingReceipt.fields.file.members[1].cases.KeepCurrentFile.make(
    {},
  );

const baseReceipt: Receipt = {
  receiptId,
  visualId: ReceiptVisualId.make("LIFECYCLE-1"),
  ownerPersonId: actors.owner.personId,
  departmentId: department,
  amountOre: 12_345,
  currency: "NOK",
  description: "Travel",
  receiptDate: "2026-08-19",
  submittedAt: "2026-08-20T12:00:00.000Z",
  status: "Pending",
  approvedAt: null,
  paymentAccountCiphertext: "ciphertext:v1:lifecycle",
  file: baseFile,
  revision: 0,
};

const statusOfStart = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
} as const satisfies Record<Exclude<StartKind, "absent">, ReceiptStatus>;

/** A receipt in the state of each start, at any revision: both deciders are total in the receipt. */
const receiptAt = (start: StartKind, revision: number): Receipt | undefined =>
  start === "absent"
    ? undefined
    : Struct.assign(baseReceipt, {
        status: statusOfStart[start],
        approvedAt: start === "approved" ? "2026-08-20T12:05:00.000Z" : null,
        revision,
      });

const decisionContextAt = (index: number) => ({
  receiptId,
  visualId: ReceiptVisualId.make("LIFECYCLE-1"),
  now: `2026-08-20T12:${String(index).padStart(2, "0")}:00.000Z`,
});

/** What one generated step asks for; the test turns it into a command against the current receipt. */
const StepSchema = Schema.Struct({
  command: Schema.Literals(commandKinds),
  // Extra copies of a kind weight the draw: the fitting actor comes up six times in ten and a
  // current revision five times in seven, so deep paths are likely and the rare ones stay reachable.
  actor: Schema.Literals([...actorKinds, "fitting", "fitting", "fitting", "fitting", "fitting"]),
  revision: Schema.Literals([...revisionKinds, "current", "current", "current", "current"]),
  file: Schema.Literals(fileKinds),
  amountOre: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
});

type Step = typeof StepSchema.Type;

const opening: Step = {
  command: "SubmitReceipt",
  actor: "fitting",
  revision: "current",
  file: "keep",
  amountOre: 1_000,
};

type Draft = {
  readonly commandId: string;
  readonly actor: ReceiptActor;
  readonly expectedRevision: number;
  readonly amountOre: number;
  readonly selection: ReceiptFileSelection;
};

const commandOf = {
  SubmitReceipt: (draft) =>
    AuthorizedReceiptCommandSchema.cases.SubmitReceipt.make({
      commandId: draft.commandId,
      actor: draft.actor,
      departmentId: department,
      paymentAccountCiphertext: "ciphertext:v1:lifecycle",
      description: "Lifecycle receipt",
      amountOre: draft.amountOre,
      receiptDate: "2026-08-19",
      file: baseFile,
    }),
  RevisePendingReceipt: (draft) =>
    AuthorizedReceiptCommandSchema.cases.RevisePendingReceipt.make({
      commandId: draft.commandId,
      actor: draft.actor,
      receiptId,
      expectedRevision: draft.expectedRevision,
      description: "Revised lifecycle receipt",
      amountOre: draft.amountOre,
      receiptDate: "2026-08-20",
      file: draft.selection,
    }),
  WithdrawPendingReceipt: (draft) =>
    AuthorizedReceiptCommandSchema.cases.WithdrawPendingReceipt.make({
      commandId: draft.commandId,
      actor: draft.actor,
      receiptId,
      expectedRevision: draft.expectedRevision,
    }),
  ApproveReceipt: (draft) =>
    AuthorizedReceiptCommandSchema.cases.ApproveReceipt.make({
      commandId: draft.commandId,
      actor: draft.actor,
      receiptId,
      expectedRevision: draft.expectedRevision,
    }),
  RejectReceipt: (draft) =>
    AuthorizedReceiptCommandSchema.cases.RejectReceipt.make({
      commandId: draft.commandId,
      actor: draft.actor,
      receiptId,
      expectedRevision: draft.expectedRevision,
    }),
  ReopenRejectedReceipt: (draft) =>
    AuthorizedReceiptCommandSchema.cases.ReopenRejectedReceipt.make({
      commandId: draft.commandId,
      actor: draft.actor,
      receiptId,
      expectedRevision: draft.expectedRevision,
    }),
} as const satisfies Record<Step["command"], (draft: Draft) => ReceiptCommand>;

// A revision behind the current one stops at zero, because no command may carry a negative one.
const expectedRevisionOf = (kind: Step["revision"], current: number): number =>
  Match.value(kind).pipe(
    Match.when("current", () => current),
    Match.when("behind", () => Math.max(0, current - 1)),
    Match.when("ahead", () => current + 1),
    Match.exhaustive,
  );

const selectionOf = (
  kind: Step["file"],
  previous: Receipt | undefined,
  index: number,
): ReceiptFileSelection => {
  if (kind === "keep") return keepCurrentFile;

  if (kind === "same") return previous?.file ?? baseFile;

  return {
    ...baseFile,
    fileRef: `staged/lifecycle-replacement-${index}`,
    objectKey: `receipts/lifecycle-replacement-${index}`,
  };
};

const commandFor = (step: Step, previous: Receipt | undefined, index: number): ReceiptCommand =>
  commandOf[step.command]({
    commandId: `lifecycle-command-${index}`,
    actor: actors[step.actor === "fitting" ? fittingActor[step.command] : step.actor],
    expectedRevision: expectedRevisionOf(step.revision, previous?.revision ?? 0),
    amountOre: step.amountOre,
    selection: selectionOf(step.file, previous, index),
  });

class RecordedDecisions extends Context.Service<
  RecordedDecisions,
  Ref.Ref<ReadonlyArray<ReceiptDecision>>
>()("@vektorprogrammet/domain/receipt/lifecycle-legal.test/RecordedDecisions") {
  static readonly layer = Layer.effect(
    RecordedDecisions,
    Ref.make<ReadonlyArray<ReceiptDecision>>([]),
  );
}

/** A transaction that keeps every recorded decision, in order, in a Ref that the test reads. */
const ReceiptCommandTxTest = Layer.effect(
  ReceiptCommandTx,
  Effect.gen(function* () {
    const recorded = yield* RecordedDecisions;

    return ReceiptCommandTx.of({
      record: (decision) => Ref.update(recorded, (decisions) => [...decisions, decision]),
    });
  }),
).pipe(Layer.provideMerge(RecordedDecisions.layer));

/**
 * The comparable face of a run: the decision, or the failure with its tag, fields, and message.
 * The tag and the fields are own properties of a failure and the message is not, so it is added.
 */
const observed = (result: Result.Result<ReceiptDecision, ReceiptFailure>) =>
  Result.match(result, {
    onSuccess: (decision) => ({ success: decision }),
    onFailure: (failure) => ({
      failure: { ...Object.fromEntries(Object.entries(failure)), message: failure.message },
    }),
  });

/** Runs both deciders on one command, requires the same outcome, and returns the oracle's. */
const bothDecide = Effect.fnUntraced(function* (
  receipt: Receipt | undefined,
  command: ReceiptCommand,
  index: number,
) {
  const context = decisionContextAt(index);
  const oracle = yield* Effect.result(decideReceipt(receipt, command, context));
  const machine = yield* Effect.result(runReceiptCommandLegal(receipt, command, context));
  assert.deepStrictEqual(observed(machine), observed(oracle));

  return oracle;
});

type Thread = {
  readonly receipt: Receipt | undefined;
  readonly decisions: ReadonlyArray<ReceiptDecision>;
};

it.effect.prop(
  "the legal-only actor decides exactly as decideReceipt does, and records only its decisions",
  {
    // Any start, reachable or not, and any small revision: the sequence runs from there.
    start: Schema.Literals([...startKinds, "pending", "pending", "pending", "rejected"]),
    startRevision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
    steps: Schema.Array(StepSchema).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
  },
  ({ start, startRevision, steps }) =>
    Effect.gen(function* () {
      const recorded = yield* RecordedDecisions;

      const thread = yield* Effect.reduce(
        steps,
        (): Thread => ({ receipt: receiptAt(start, startRevision), decisions: [] }),
        (state, step, index) =>
          Effect.gen(function* () {
            const command = commandFor(step, state.receipt, index);
            const oracle = yield* bothDecide(state.receipt, command, index);

            return Result.isSuccess(oracle)
              ? { receipt: oracle.success.receipt, decisions: [...state.decisions, oracle.success] }
              : state;
          }),
      );

      assert.deepStrictEqual(yield* Ref.get(recorded), thread.decisions);
    }).pipe(Effect.provide(ReceiptCommandTxTest)),
  { arbitrary: { seed: 22082034, runs: 200 } },
);

// Only a revision carries a file selection, so only it varies the file.
const grid = startKinds.flatMap((start) =>
  commandKinds.flatMap((command) =>
    actorKinds.flatMap((actor) =>
      revisionKinds.flatMap((revision) =>
        (command === "RevisePendingReceipt" ? fileKinds : [opening.file]).map((file) => ({
          start,
          step: { ...opening, command, actor, revision, file },
        })),
      ),
    ),
  ),
);

it.effect("decides as decideReceipt does for every state, command, actor, revision, and file", () =>
  Effect.gen(function* () {
    const oracles = yield* Effect.forEach(grid, ({ start, step }) => {
      const receipt = receiptAt(start, 2);

      return bothDecide(receipt, commandFor(step, receipt, 0), 0);
    });

    // The grid is not vacuous: it reaches every decision and every failure that decideReceipt has.
    assert.sameMembers(
      [
        ...new Set(
          oracles.map((oracle) =>
            Result.match(oracle, {
              onSuccess: (decision) => decision.auditAction,
              onFailure: (failure) => failure._tag,
            }),
          ),
        ),
      ],
      [
        "ReceiptSubmitted",
        "PendingReceiptRevised",
        "PendingReceiptWithdrawn",
        "ReceiptApproved",
        "ReceiptRejected",
        "RejectedReceiptReopened",
        "InactiveActor",
        "ReceiptNotFound",
        "ReceiptAlreadyExists",
        "ReceiptScopeDenied",
        "ReceiptOwnerDenied",
        "StaleReceiptRevision",
        "InvalidReceiptTransition",
      ],
    );
  }).pipe(Effect.provide(ReceiptCommandTxTest)),
);

it.effect("fails a malformed command with the decode error of decideReceipt", () =>
  Effect.gen(function* () {
    const submit = commandFor(opening, undefined, 0);

    const approve = commandFor(
      { ...opening, command: "ApproveReceipt" },
      receiptAt("pending", 0),
      0,
    );

    const malformed = [
      { ...submit, amountOre: "twelve" },
      { ...submit, unexpected: true },
      { ...approve, expectedRevision: -1 },
    ];

    for (const input of malformed) {
      const oracle = yield* Effect.result(decideReceipt(undefined, input, decisionContextAt(0)));

      const machine = yield* Effect.result(
        runReceiptCommandLegal(undefined, input, decisionContextAt(0)),
      );

      assert.strictEqual(Result.isFailure(machine) && machine.failure._tag, "ReceiptDecodeError");
      assert.deepStrictEqual(observed(machine), observed(oracle));
    }
  }).pipe(Effect.provide(ReceiptCommandTxTest)),
);

it.effect("keeps a failed write a defect, never a refusal", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      runReceiptCommandLegal(undefined, commandFor(opening, undefined, 0), decisionContextAt(0)),
    );

    assert.isTrue(Exit.isFailure(exit));

    if (Exit.isFailure(exit)) {
      assert.isTrue(Cause.hasDies(exit.cause));
      assert.isFalse(Cause.hasFails(exit.cause));
      // The defect is the error that the write failed with, not the stopped actor around it.
      assert.strictEqual(Cause.squash(exit.cause), "the transaction write failed");
    }
  }).pipe(
    Effect.provide(
      Layer.succeed(
        ReceiptCommandTx,
        ReceiptCommandTx.of({ record: () => Effect.die("the transaction write failed") }),
      ),
    ),
  ),
);

it.effect("interrupts the write and ends the command as interrupted when the caller cancels", () =>
  Effect.gen(function* () {
    const writing = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();

    const stuckTx = Layer.succeed(
      ReceiptCommandTx,
      ReceiptCommandTx.of({
        record: () =>
          Deferred.succeed(writing, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
      }),
    );

    const fiber = yield* Effect.forkChild(
      runReceiptCommandLegal(
        undefined,
        commandFor(opening, undefined, 0),
        decisionContextAt(0),
      ).pipe(Effect.provide(stuckTx)),
    );

    yield* Deferred.await(writing);
    yield* Fiber.interrupt(fiber);
    yield* Deferred.await(interrupted);
    const exit = yield* Fiber.await(fiber);

    assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
  }),
);

/**
 * What each state accepts, written from the legal table of `decideCommand` in `update.ts`:
 * `SubmitReceipt` needs no receipt; a revision, a withdrawal, an approval, and a rejection need a
 * pending one; a reopening needs a rejected one. A stale revision and the authority of the actor
 * are runtime preconditions of a command, checked before the machine is asked. They are not facts
 * about a receipt, so they are not part of what a state accepts.
 */
const acceptedBy: Record<StartKind, ReadonlyArray<CommandKind>> = {
  absent: ["SubmitReceipt"],
  pending: ["RevisePendingReceipt", "WithdrawPendingReceipt", "ApproveReceipt", "RejectReceipt"],
  approved: [],
  rejected: ["ReopenRejectedReceipt"],
  withdrawn: [],
};

it.effect("accepts in each state the commands that decideReceipt accepts in it", () =>
  Effect.gen(function* () {
    // The fitting actor and the current revision, so that only the state can refuse.
    for (const start of startKinds) {
      const receipt = receiptAt(start, 2);

      for (const command of commandKinds) {
        const outcome = yield* Effect.result(
          decideReceipt(
            receipt,
            commandFor({ ...opening, command }, receipt, 0),
            decisionContextAt(0),
          ),
        );

        assert.strictEqual(
          Result.isSuccess(outcome),
          acceptedBy[start].includes(command),
          `${start} ${command}`,
        );
      }
    }
  }),
);

/**
 * What a machine reports about the commands of a receipt, for each of the three questions that a
 * caller can ask of it without running an actor: the transitions that the hydrated state lists,
 * `snapshot.can`, and whether the pure `transition` leaves the snapshot unhandled. Every answer
 * that differs from the table of `acceptedBy` is a mismatch.
 */
const projectionMismatches = (machine: AnyStateMachine) =>
  startKinds.flatMap((start) => {
    const existing = receiptAt(start, 2);
    const input = { existing, decisionContext: decisionContextAt(0) };
    const [snapshot] = initialTransition(machine, input);
    const listed = new Set(getNextTransitions(snapshot).map((candidate) => candidate.eventType));

    return commandKinds.flatMap((command) => {
      const event = receiptCommandEvent(commandFor({ ...opening, command }, existing, 0));
      const expected = acceptedBy[start].includes(command);

      const reported = {
        listed: listed.has(command),
        can: snapshot.can(event),
        handled: !isUnhandled(snapshot, transition(machine, snapshot, event)),
      };

      return reported.listed === expected &&
        reported.can === expected &&
        reported.handled === expected
        ? []
        : [{ start, command, expected, ...reported }];
    });
  });

it("lets a server read the legal commands of a receipt from the hydrated machine", () => {
  assert.deepStrictEqual(projectionMismatches(receiptLegalMachine), []);

  for (const start of startKinds) {
    const [snapshot] = initialTransition(receiptLegalMachine, {
      existing: receiptAt(start, 2),
      decisionContext: decisionContextAt(0),
    });

    const listed = getNextTransitions(snapshot);

    // Nothing else is listed than the accepted commands, and every edge is a static edge into
    // `persisting`, so the graph shows it without running a transition function.
    assert.sameMembers(
      listed.map((candidate) => candidate.eventType),
      [...acceptedBy[start]],
    );

    assert.deepStrictEqual(
      listed.flatMap((candidate) => candidate.target?.map((node) => node.key) ?? ["dynamic"]),
      listed.map(() => "persisting"),
    );
  }
});

it("reads availability from the state alone, whatever the revision and the actor of the command", () => {
  for (const start of startKinds) {
    const existing = receiptAt(start, 2);

    const [snapshot] = initialTransition(receiptLegalMachine, {
      existing,
      decisionContext: decisionContextAt(0),
    });

    // The runner checks the revision and the authority of the actor before it asks the machine,
    // so a stale revision and an inactive actor change nothing about what a state accepts.
    for (const command of commandKinds) {
      const refusable = receiptCommandEvent(
        commandFor(
          { command, actor: "inactiveOwner", revision: "ahead", file: "keep", amountOre: 1 },
          existing,
          0,
        ),
      );

      assert.strictEqual(
        snapshot.can(refusable),
        acceptedBy[start].includes(command),
        `${start} ${command}`,
      );
    }
  }
});

it("detects a machine with refusal edges: the same projection check fails on spike 1", () => {
  const mismatches = projectionMismatches(receiptMachine);

  const refused = startKinds.flatMap((start) =>
    commandKinds.flatMap((command) =>
      acceptedBy[start].includes(command) ? [] : [{ start, command }],
    ),
  );

  // 5 starts and 6 commands are 30 cells, 6 of them accepted: the 24 others are refused, and
  // spike 1 reports each of them as available by all three questions, and nothing else.
  assert.strictEqual(refused.length, 24);

  assert.deepStrictEqual(
    mismatches.map(({ start, command }) => ({ start, command })),
    refused,
  );

  assert.isTrue(
    mismatches.every(
      (mismatch) => !mismatch.expected && mismatch.listed && mismatch.can && mismatch.handled,
    ),
  );
});

/** Traversal sends one event per command, hydrated for the receipt, and each invoke result. */
const isActorDone = (event: AnyEventObject): event is DoneActorEvent =>
  event.type === "xstate.done.actor";

const commandEventsFor = (existing: Receipt | undefined) =>
  commandKinds.map((command) =>
    receiptCommandEvent(commandFor({ ...opening, command }, existing, 0)),
  );

it("reaches every state, and ends in its only final state, from each hydrated state", () => {
  const visited = new Set<string>();
  const finished = new Set<string>();

  for (const start of startKinds) {
    const existing = receiptAt(start, 3);
    const input = { existing, decisionContext: decisionContextAt(0) };

    // `hydrating` is transient: it shows only in the first microstep, before its eventless edge.
    for (const [snapshot] of getInitialMicrosteps(receiptLegalMachine, input)) {
      visited.add(String(snapshot.value));
    }

    const paths = getShortestPaths(receiptLegalMachine, {
      input,
      events: (snapshot) => [
        ...commandEventsFor(existing),
        ...getAllOwnEvents(snapshot).filter(isActorDone),
      ],
    });

    for (const path of paths) {
      visited.add(String(path.state.value));

      if (path.state.status === "done") finished.add(String(path.state.value));
    }
  }

  assert.sameMembers([...visited], Object.keys(receiptLegalMachine.states));
  assert.sameMembers([...finished], ["decided"]);
});

it("keeps one lifecycle state per receipt status and hydrates each status into its own", () => {
  const technicalStates = ["hydrating", "absent", "persisting", "decided"];

  assert.sameMembers(
    Object.keys(receiptLegalMachine.states).filter((state) => !technicalStates.includes(state)),
    Object.values(receiptStateOfStatus),
  );
  assert.sameMembers(Object.keys(receiptStateOfStatus), [...ReceiptStatusSchema.literals]);

  // Approved and withdrawn accept nothing, so only this check tells a receipt hydrated into the
  // wrong one of them.
  for (const start of startKinds.filter((kind) => kind !== "absent")) {
    const [snapshot] = initialTransition(receiptLegalMachine, {
      existing: receiptAt(start, 0),
      decisionContext: decisionContextAt(0),
    });

    assert.strictEqual(snapshot.value, start);
  }
});

class Mailer extends Context.Service<Mailer, { readonly send: Effect.Effect<void> }>()(
  "@vektorprogrammet/domain/receipt/lifecycle-legal.test/Mailer",
) {}

// The negative control: a machine whose actor needs a provider service says so in its type.
const mailingMachine = setupEffect({
  actors: { notify: fromEffect(Mailer.use((mailer) => mailer.send)) },
}).createMachine({ initial: "idle", states: { idle: { invoke: { src: "notify" } } } });

it("requires only the transaction service, and a machine that requires more says so in its type", () => {
  expectTypeOf<RequirementsFrom<typeof receiptLegalMachine>>().toEqualTypeOf<ReceiptCommandTx>();
  expectTypeOf<RequirementsFrom<typeof mailingMachine>>().toEqualTypeOf<Mailer>();
  expectTypeOf<RequirementsFrom<typeof mailingMachine>>().not.toEqualTypeOf<ReceiptCommandTx>();

  expectTypeOf(runReceiptCommandLegal).returns.toEqualTypeOf<
    Effect.Effect<ReceiptDecision, ReceiptFailure, ReceiptCommandTx>
  >();
});
