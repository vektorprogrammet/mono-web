import { Dialog } from "@foldkit/ui";
import { AssessmentCorrection } from "@vektorprogrammet/domain/recruitment";
import { canonicalJsonBytes } from "@vektorprogrammet/domain/shared-kernel";
import {
  RecruitmentInterviewId,
  RecruitmentMaintenanceCommand,
  RecruitmentMaintenanceResult,
} from "@vektorprogrammet/http-api";
import { DateTime, Option, Predicate, Schema } from "effect";
import { Interruptible } from "foldkit/command";
import { FocusCorrectionReopen } from "./command";
import { Story } from "foldkit/test";
import { describe, expect, it } from "vitest";
import {
  ChangedCorrectionEndsAt,
  ChangedCorrectionReason,
  CompletedPrepareEdit,
  CompletedCancelWorkflowFocus,
  CompletedCancelMaintenanceLoad,
  CompletedWorkflowFocus,
  FailedWorkflowFocus,
  FailedLoad,
  FailedSave,
  GotCorrectionDialogMessage,
  OpenedCorrectionWindow,
  RefreshedMaintenance,
  ResumedEditing,
  RetriedMaintenance,
  SelectedRecord,
  SubmittedCorrectionWindow,
  SubmittedMaintenance,
  SucceededSave,
  SucceededStaffing,
} from "./message";
import { Mutation, type Model } from "./model";
import {
  closedObservation,
  expiredObservation,
  openObservation,
  staffingModel,
  testCommandId,
  testCommands,
  testInterviewId,
} from "./test-support";
import { updateFor } from "./update";

const commands = testCommands();

const update = updateFor(commands);

const windowDraft = (): Model => {
  const opened = update(
    staffingModel(closedObservation()),
    OpenedCorrectionWindow({ action: "Reopen" }),
  ).model;

  const reason = update(
    opened,
    ChangedCorrectionReason({ value: "Correction after decision closure" }),
  ).model;

  return update(reason, ChangedCorrectionEndsAt({ value: "2031-09-14T15:00:00+02:00" })).model;
};

const pendingCommand = (model: Model) => {
  if (!Predicate.isTagged(model.mutation, "Pending")) throw new Error("Expected pending command");

  return model.mutation.command;
};

describe("R2 server-owned correction window model", () => {
  it("building and discarding window and dialog commands runs no work", () => {
    let calls = 0;

    const guarded = updateFor(
      testCommands(() => {
        calls += 1;
      }),
    );

    const opened = guarded(
      staffingModel(closedObservation()),
      OpenedCorrectionWindow({ action: "Reopen" }),
    );

    expect(opened.commands?.map((command) => command.name)).toEqual(["ShowDialog"]);

    const submitted = guarded(
      {
        ...opened.model,
        correctionReason: "Audit reason",
        correctionEndsAt: "2031-09-14T13:00:00Z",
      },
      SubmittedCorrectionWindow(),
    );

    expect(submitted.commands?.map((command) => command.name)).toEqual([
      "SaveRecruitmentMaintenance",
    ]);
    expect(calls).toBe(0);
  });

  it("false server flags refuse forged open messages, including completed interviews", () => {
    for (const observation of [
      closedObservation(false),
      AssessmentCorrection.cases.Ordinary.make({
        sequence: 0,
        canCorrect: false,
        canReopen: false,
        canClose: false,
      }),
    ]) {
      const model = staffingModel(observation);

      for (const action of ["Reopen", "Close"] as const) {
        const result = update(model, OpenedCorrectionWindow({ action }));
        expect(result.model).toBe(model);
        expect(result.commands).toEqual([]);
      }
    }
  });

  it("decodes explicit-zone input to Instant and submits the observed sequence, not interview revision", () => {
    const result = update(windowDraft(), SubmittedCorrectionWindow());
    const command = pendingCommand(result.model);

    if (!Predicate.isTagged(command, "ReopenAssessmentCorrection"))
      throw new Error("Expected reopen");
    expect(command.commandId).toBe(testCommandId);
    expect(command.expectedSequence).toBe(2);
    expect(DateTime.formatIso(command.endsAt)).toBe("2031-09-14T13:00:00.000Z");
    expect(Schema.encodeSync(RecruitmentMaintenanceCommand)(command)).toMatchObject({
      endsAt: "2031-09-14T13:00:00.000Z",
    });
    expect(result.commands).toHaveLength(1);
  });

  it("rejects missing timezone, normalized invalid date and blank or overlong reason without a request", () => {
    for (const changes of [
      { correctionEndsAt: "2031-09-14T15:00" },
      { correctionEndsAt: "2031-02-30T15:00:00Z" },
      { correctionReason: "   " },
      { correctionReason: "x".repeat(2001) },
    ]) {
      const result = update({ ...windowDraft(), ...changes }, SubmittedCorrectionWindow());
      expect(result.model.mutation._tag).toBe("Invalid");
      expect(result.commands).toEqual([]);
    }
  });

  it("closes using its observed sequence without requiring a new end date", () => {
    const opened = update(
      staffingModel(openObservation()),
      OpenedCorrectionWindow({ action: "Close" }),
    ).model;

    const result = update(
      { ...opened, correctionReason: "Assessment correction finished" },
      SubmittedCorrectionWindow(),
    );

    expect(pendingCommand(result.model)._tag).toBe("CloseAssessmentCorrection");
    expect(pendingCommand(result.model)).toMatchObject({ expectedSequence: 3 });
    expect("endsAt" in pendingCommand(result.model)).toBe(false);
  });

  it("a changed sequence or revoked server permission invalidates a previously opened confirmation", () => {
    const draft = windowDraft();

    for (const observation of [
      closedObservation(false),
      AssessmentCorrection.cases.Closed.make({
        sequence: 3,
        canCorrect: false,
        canReopen: true,
        canClose: false,
      }),
    ]) {
      const result = update(
        { ...draft, staffing: staffingModel(observation).staffing },
        SubmittedCorrectionWindow(),
      );

      expect(result.model.mutation._tag).toBe("Invalid");
      expect(result.commands).toEqual([]);
    }
  });

  it("uncertain retry preserves exact command/id and draft; new editing gets a new identity", () => {
    const pending = update(windowDraft(), SubmittedCorrectionWindow()).model;
    const command = pendingCommand(pending);

    if (!Predicate.isTagged(command, "ReopenAssessmentCorrection"))
      throw new Error("Expected reopen");
    const encodeCommand = Schema.encodeSync(RecruitmentMaintenanceCommand);
    const originalBytes = canonicalJsonBytes(encodeCommand(command));

    const failed = update(
      pending,
      FailedSave({ commandId: testCommandId, message: "Uncertain response", conflict: false }),
    ).model;

    expect(update(failed, ChangedCorrectionReason({ value: "Different payload" })).model).toBe(
      failed,
    );
    const retried = update(failed, RetriedMaintenance());
    const retriedCommand = pendingCommand(retried.model);

    if (!Predicate.isTagged(retriedCommand, "ReopenAssessmentCorrection"))
      throw new Error("Expected reopen retry");
    // Schema reconstruction may clone values; retry identity is the complete
    // encoded command, not its JavaScript reference.
    expect(canonicalJsonBytes(encodeCommand(retriedCommand))).toEqual(originalBytes);
    expect(retriedCommand.commandId).toBe(command.commandId);
    expect(retriedCommand.reason).toBe(command.reason);
    expect(retriedCommand.expectedSequence).toBe(command.expectedSequence);
    expect(DateTime.formatIso(retriedCommand.endsAt)).toBe(DateTime.formatIso(command.endsAt));
    expect(retried.commands).toHaveLength(1);
    expect(retried.commands?.[0]?.args).toEqual({ command });
    expect(retried.model.commandId).toBe(failed.commandId);
    expect(retried.model.correctionReason).toBe(failed.correctionReason);
    expect(retried.model.correctionEndsAt).toBe(failed.correctionEndsAt);
    expect(retried.model.correctionSequence).toBe(failed.correctionSequence);

    const resumed = update(
      failed,
      CompletedPrepareEdit({ commandId: "new-correction-window-command-0029" }),
    ).model;

    expect(resumed.commandId).not.toBe(testCommandId);
    expect(resumed.correctionReason).toBe(failed.correctionReason);
    expect(update(failed, ResumedEditing()).commands?.[0]?.name).toBe("PrepareMaintenanceEdit");
  });

  it("pending save refuses Escape, duplicate submission, selection and unrelated staffing mutation", () => {
    const pending = update(windowDraft(), SubmittedCorrectionWindow()).model;

    for (const message of [
      GotCorrectionDialogMessage({ message: Dialog.Message.RequestedClose(), generation: pending.dialogGeneration }),
      SubmittedCorrectionWindow(),
      SelectedRecord({ id: "different-interview" }),
      SubmittedMaintenance(),
    ]) {
      expect(update(pending, message).model).toBe(pending);
      expect(update(pending, message).commands).toEqual([]);
    }
  });

  it("stale responses cannot overwrite the active attempt; accepted window result refreshes facts", () => {
    const pending = update(windowDraft(), SubmittedCorrectionWindow()).model;

    const result = RecruitmentMaintenanceResult.cases.AssessmentCorrectionReopened.make({
      interviewId: RecruitmentInterviewId.make(testInterviewId),
      sequence: 3,
    });

    expect(
      update(pending, SucceededSave({ commandId: "another-correction-window-command", result }))
        .model,
    ).toBe(pending);
    expect(
      update(
        pending,
        SucceededSave({
          commandId: testCommandId,
          result: RecruitmentMaintenanceResult.cases.AssessmentCorrectionClosed.make({
            interviewId: result.interviewId,
            sequence: 3,
          }),
        }),
      ).model,
    ).toBe(pending);
    expect(
      update(
        pending,
        SucceededSave({
          commandId: testCommandId,
          result: RecruitmentMaintenanceResult.cases.AssessmentCorrectionReopened.make({
            interviewId: RecruitmentInterviewId.make("another-interview"),
            sequence: 3,
          }),
        }),
      ).model,
    ).toBe(pending);
    const saved = update(pending, SucceededSave({ commandId: testCommandId, result }));
    expect(saved.model.status).toBe("Loading");
    expect(saved.model.correctionDialog.isOpen).toBe(false);
    expect(saved.model.expectedRevision).toBe(4);
    expect(saved.commands?.map((command) => command.name)).toEqual([
      "CloseDialog",
      "LoadRecruitmentMaintenance",
    ]);
    const observed = staffingModel(openObservation());

    const refreshed = update(
      saved.model,
      SucceededStaffing({
        requestId: saved.model.requestId,
        data: observed.staffing!,
        commandId: "fresh-correction-window-command-0029",
      }),
    ).model;

    expect(refreshed.staffing?.interviews[0]?.assessmentCorrection._tag).toBe("Open");
    expect(refreshed.correctionReason).toBe("");
    expect(update(refreshed, SubmittedCorrectionWindow()).commands).toEqual([]);
  });

  it("Story closes the Dialog through its recorded lift and retains the cancelled draft without executing commands", () => {
    Story.story(
      update,
      Story.given(staffingModel(closedObservation())),
      Story.message(OpenedCorrectionWindow({ action: "Reopen" })),
      Story.Command.resolveAllExact([Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()]),
      Story.message(ChangedCorrectionReason({ value: "Draft not submitted" })),
      Story.message(GotCorrectionDialogMessage({ message: Dialog.Message.RequestedClose(), generation: 1 })),
      Story.Command.resolveAllExact([Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()]),
      Story.model((model) => {
        expect(model.correctionDialog.isOpen).toBe(false);
        expect(model.correctionReason).toBe("Draft not submitted");
      }),
      Story.Command.expectNone(),
    );
  });

  it("refresh and stale-sequence refusal do not leave an active confirmation", () => {
    const draft = windowDraft();
    const refreshed = update(draft, RefreshedMaintenance());
    expect(refreshed.model.correctionDialog.isOpen).toBe(false);
    expect(refreshed.model.correctionAction).toBeNull();
    expect(refreshed.commands?.map((command) => command.name)).toEqual([
      "CloseDialog",
      "LoadRecruitmentMaintenance",
    ]);

    const failed = update(
      update(draft, SubmittedCorrectionWindow()).model,
      FailedSave({
        commandId: testCommandId,
        conflict: true,
        message: "Server refused stale sequence",
      }),
    ).model;

    expect(failed.mutation).toEqual(
      Mutation.cases.Conflict.make({ message: "Server refused stale sequence" }),
    );
    expect(update(failed, RetriedMaintenance()).commands).toEqual([]);
    expect(failed.correctionReason).toBe(draft.correctionReason);
  });

  it("schema rejects contradictory server flags instead of treating independent booleans as policy", () => {
    for (const invalid of [
      { ...Schema.encodeSync(AssessmentCorrection)(closedObservation()), canCorrect: true },
      {
        ...Schema.encodeSync(AssessmentCorrection)(
          AssessmentCorrection.cases.Ordinary.make({
            sequence: 0,
            canCorrect: true,
            canReopen: false,
            canClose: false,
          }),
        ),
        canReopen: true,
      },
      { ...Schema.encodeSync(AssessmentCorrection)(expiredObservation()), canClose: true },
    ])
      expect(Option.isNone(Schema.decodeUnknownOption(AssessmentCorrection)(invalid))).toBe(true);
    expect(expiredObservation()._tag).toBe("Expired");
  });
});

it("R2 dismissing a dialog retains its draft, but selecting another interview resets it", () => {
  const draft = windowDraft();

  const dismissed = update(
    draft,
    GotCorrectionDialogMessage({ message: Dialog.Message.RequestedClose(), generation: draft.dialogGeneration }),
  ).model;

  const closeCompleted = update(dismissed, GotCorrectionDialogMessage({ message: Dialog.Message.CompletedCloseDialog(), generation: dismissed.dialogGeneration })).model;
  const reopened = update(closeCompleted, OpenedCorrectionWindow({ action: "Reopen" })).model;
  expect(reopened.correctionReason).toBe(draft.correctionReason);
  expect(reopened.correctionEndsAt).toBe(draft.correctionEndsAt);
  const selected = update(dismissed, SelectedRecord({ id: "another-interview" })).model;
  expect(selected.correctionAction).toBeNull();
  expect(selected.correctionReason).toBe("");
});

it("R2 a duplicated read response cannot replace a pending window draft or its command identity", () => {
  const pending = update(windowDraft(), SubmittedCorrectionWindow()).model;
  const source = staffingModel(openObservation());
  expect(
    update(
      pending,
      SucceededStaffing({
        requestId: pending.requestId,
        data: source.staffing!,
        commandId: "duplicate-read-command-0029",
      }),
    ).model,
  ).toBe(pending);
});

const closingReload = () => {
  const opened = update(staffingModel(openObservation()), OpenedCorrectionWindow({ action: "Close" })).model;
  const pending = update({ ...opened, correctionReason: "Close finished window" }, SubmittedCorrectionWindow()).model;

  return update(pending, SucceededSave({ commandId: testCommandId, result: RecruitmentMaintenanceResult.cases.AssessmentCorrectionClosed.make({ interviewId: RecruitmentInterviewId.make(testInterviewId), sequence: 4 }) }));
};

const readyClose = (canReopen = true) => {
  const loading = closingReload().model;

  return update(loading, SucceededStaffing({ requestId: loading.requestId, commandId: "new-read-command", data: staffingModel(closedObservation(canReopen)).staffing! }));
};

it("sequences production Save Load correlated native Close completion and one inert Focus", () => {
  const loading = closingReload();
  expect(loading.model.correctionDialog.isOpen).toBe(true);
  expect(loading.commands?.map((command) => command.name)).toEqual(["LoadRecruitmentMaintenance"]);
  const ready = readyClose();
  expect(ready.model.workflowFocus?.phase).toBe("Closing");
  expect(ready.commands?.map((command) => command.name)).toEqual(["CloseDialog"]);
  const ticket = ready.model.workflowFocus!.ticket;
  Story.story(update, Story.given(ready.model), (simulation) => ({ ...simulation, commands: ready.commands ?? [] }),
    Story.Command.resolve(Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()),
    Story.Command.expectExact(FocusCorrectionReopen(ticket)),
    Story.Command.resolveAllExact([FocusCorrectionReopen, CompletedWorkflowFocus({ ticket })]),
    Story.model((model) => expect(model.workflowFocus).toBeNull()));
  expect(() => FocusCorrectionReopen({ ...ticket, interviewId: "css:punctuation[]" })).not.toThrow();
});

it.each(["requestId", "commandId", "interviewId"] as const)("rejects stale %s close/focus/cancel tickets", (field) => {
  const ready = readyClose();
  const ticket = ready.model.workflowFocus!.ticket;
  const stale = { ...ticket, [field]: field === "requestId" ? ticket.requestId + 1 : "stale" };
  expect(update(ready.model, GotCorrectionDialogMessage({ generation: ready.model.dialogGeneration, ticket: stale, message: Dialog.Message.CompletedCloseDialog() })).commands).toEqual([]);
  const focusing = update(ready.model, GotCorrectionDialogMessage({ generation: ready.model.dialogGeneration, ticket, message: Dialog.Message.CompletedCloseDialog() })).model;

  for (const message of [CompletedWorkflowFocus({ ticket: stale }), FailedWorkflowFocus({ ticket: stale })]) expect(update(focusing, message).model).toBe(focusing);
  const cancelled = update(focusing, SelectedRecord({ id: "another-interview" })).model;
  expect(cancelled.workflowFocus).toBeNull();
  expect(update(cancelled, CompletedCancelWorkflowFocus({ ticket: stale, outcome: Interruptible.Outcome.NotFound() })).model).toBe(cancelled);
});

it("old close generation cannot close or focus a newer dialog; cancellation completes before replacement", () => {
  const ready = readyClose().model;
  const ticket = ready.workflowFocus!.ticket;
  expect(update(ready, GotCorrectionDialogMessage({ generation: ready.dialogGeneration - 1, ticket, message: Dialog.Message.CompletedCloseDialog() })).model).toBe(ready);
  expect(update(ready, OpenedCorrectionWindow({ action: "Reopen" })).model).toBe(ready);
  const focusing = update(ready, GotCorrectionDialogMessage({ generation: ready.dialogGeneration, ticket, message: Dialog.Message.CompletedCloseDialog() })).model;
  const cancelled = update(focusing, SelectedRecord({ id: testInterviewId }));
  expect(cancelled.commands?.map((command) => command.name)).toEqual(["FocusCorrectionReopen.Interrupt"]);
  expect(update(cancelled.model, OpenedCorrectionWindow({ action: "Reopen" })).model).toBe(cancelled.model);
  const settled = update(cancelled.model, CompletedCancelWorkflowFocus({ ticket, outcome: Interruptible.Outcome.NotFound() })).model;
  const opened = update(settled, OpenedCorrectionWindow({ action: "Reopen" })).model;
  expect(opened.correctionDialog.isOpen).toBe(true);
  expect(update(opened, GotCorrectionDialogMessage({ generation: ready.dialogGeneration, ticket, message: Dialog.Message.CompletedCloseDialog() })).model).toBe(opened);
});

it.each([false, true])("failed reload (denied=%s) releases modal and never focuses", (denied) => {
  const loading = closingReload().model;
  const failed = update(loading, FailedLoad({ requestId: loading.requestId, denied }));
  expect(failed.model.workflowFocus).toBeNull();
  expect(failed.model.status).toBe(denied ? "Denied" : "Failed");
  expect(failed.model.correctionDialog.isOpen).toBe(false);
  expect(failed.commands?.map((command) => command.name)).toEqual(["CloseDialog"]);
});

it("no server Reopen permission releases without focus", () => {
  const ready = readyClose(false);
  expect(ready.model.workflowFocus).toBeNull();
  Story.story(update, Story.given(ready.model), (simulation) => ({ ...simulation, commands: ready.commands ?? [] }), Story.Command.resolveAllExact([Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()]), Story.Command.expectNone());
});

it.each(["dismiss", "refresh"] as const)("%s cancels reload before ordinary replacement; stale reads cannot rearm", (action) => {
  const loading = closingReload().model;
  const cancelled = update(loading, action === "dismiss" ? GotCorrectionDialogMessage({ message: Dialog.Message.RequestedClose(), generation: loading.dialogGeneration }) : RefreshedMaintenance());
  expect(cancelled.model.workflowFocus).toBeNull();
  expect(cancelled.commands?.map((command) => command.name)).toEqual(["LoadRecruitmentMaintenance.Interrupt", "CloseDialog"]);
  expect(cancelled.model.requestId).toBe(loading.requestId + 1);
  expect(update(cancelled.model, SucceededStaffing({ requestId: loading.requestId, data: staffingModel(closedObservation()).staffing!, commandId: "late" })).model).toBe(cancelled.model);
  const replacement = update(cancelled.model, CompletedCancelMaintenanceLoad({ requestId: loading.requestId, outcome: Interruptible.Outcome.Interrupted() }));
  expect(replacement.commands?.map((command) => command.name)).toEqual(["LoadRecruitmentMaintenance"]);
  expect(replacement.model.workflowFocus).toBeNull();
  expect(update(replacement.model, SucceededSave({ commandId: testCommandId, result: RecruitmentMaintenanceResult.cases.AssessmentCorrectionClosed.make({ interviewId: RecruitmentInterviewId.make(testInterviewId), sequence: 4 }) })).model).toBe(replacement.model);
});

it("selection during correlated reload clears intent and cancels before replacing the read", () => {
  const loading = closingReload().model;
  const selected = update(loading, SelectedRecord({ id: "another-current-interview" }));
  expect(selected.model.workflowFocus).toBeNull();
  expect(selected.model.selectedId).toBe("another-current-interview");
  expect(selected.model.correctionDialog.isOpen).toBe(false);
  expect(selected.commands?.map((command) => command.name)).toEqual(["LoadRecruitmentMaintenance.Interrupt", "CloseDialog"]);
  const replacement = update(selected.model, CompletedCancelMaintenanceLoad({ requestId: loading.requestId, outcome: Interruptible.Outcome.Interrupted() }));
  expect(replacement.commands?.map((command) => command.name)).toEqual(["LoadRecruitmentMaintenance"]);
  expect(replacement.model.selectedId).toBe("another-current-interview");
});

