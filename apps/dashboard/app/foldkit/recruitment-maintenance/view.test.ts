// @vitest-environment happy-dom
import { Dialog } from "@foldkit/ui";
import { AssessmentCorrection } from "@vektorprogrammet/domain/recruitment";
import { Runtime, Command } from "foldkit";
import { Deferred, Effect, Predicate, Schema, type Scope } from "effect";
import { it as itEffect } from "@effect/vitest";
import { createEffectClient, type FetchCapability } from "@vektorprogrammet/sdk/effect";
import { InterviewStaffingManagement, RecruitmentInterviewId, RecruitmentMaintenanceCommand, RecruitmentMaintenanceResult } from "@vektorprogrammet/http-api";
import { commandsFor, FocusCorrectionReopen } from "./command";
import { correctionReopenTarget } from "./correction-window";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import Intervjubemanning from "../../routes/dashboard.intervjubemanning._index";
import { registerRecruitmentMaintenanceElements, STAFFING_ELEMENT } from "./elements";
import { Scene } from "foldkit/test";
import { describe, expect, it, vi } from "vitest";
import { FailedSave, SucceededStaffing } from "./message";
import { Model, Mutation } from "./model";
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
import { view } from "./view";

const commands = testCommands();

const config = { update: updateFor(commands), view };

describe("R2 correction window accessible view", () => {
  it("keeps completed staffing read-only while exposing only server-granted window controls", () => {
    Scene.scene(
      config,
      Scene.given(staffingModel(closedObservation())),
      Scene.expect(Scene.role("button", { name: "Lagre bemanning" })).toBeDisabled(),
      Scene.expect(Scene.role("button", { name: "Gjenåpne retting" })).toBeEnabled(),
      Scene.expect(Scene.role("button", { name: "Lukk rettingsvindu" })).toBeDisabled(),
      Scene.expect(Scene.text("Vinduversjon 2")).toBeVisible(),
    );
    Scene.scene(
      config,
      Scene.given(staffingModel(closedObservation(false))),
      Scene.expect(Scene.role("button", { name: "Gjenåpne retting" })).toBeDisabled(),
    );
  });

  it("renders opener and end from the server without inventing expired close permission", () => {
    Scene.scene(
      config,
      Scene.given(staffingModel(openObservation())),
      Scene.expect(Scene.role("button", { name: "Gjenåpne retting" })).toBeDisabled(),
      Scene.expect(Scene.role("button", { name: "Lukk rettingsvindu" })).toBeEnabled(),
      Scene.expect(Scene.selector('[aria-label="Rettingsvindu"]')).toContainText(
        "correction-window-primary",
      ),
      Scene.expect(Scene.selector('[aria-label="Rettingsvindu"]')).toContainText(
        "2031-09-14T13:00:00.000Z",
      ),
    );

    const expired = expiredObservation();

    Scene.scene(
      config,
      Scene.given(staffingModel(expired)),
      Scene.expect(Scene.role("button", { name: "Lukk rettingsvindu" })).toBeDisabled(),
      Scene.expect(Scene.role("button", { name: "Gjenåpne retting" })).toBeEnabled(),
      Scene.expect(Scene.selector('[aria-label="Rettingsvindu"]')).toContainText("allerede stengt"),
    );
  });

  it("labels the reason and zoned end, associates dialog description, and releases through its close lift", () => {
    Scene.scene(
      config,
      Scene.given(staffingModel(closedObservation())),
      Scene.click(Scene.role("button", { name: "Gjenåpne retting" })),
      Scene.Command.resolveAllExact([Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()]),
      Scene.Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      Scene.expect(Scene.role("dialog", { name: "Gjenåpne retting" })).toBeVisible(),
      Scene.expect(Scene.label("Begrunnelse for rettingsvindu")).toHaveId("rm-correction-reason"),
      Scene.expect(Scene.label("Sluttidspunkt (med tidssone)")).toHaveId("rm-correction-ends-at"),
      Scene.type(Scene.label("Begrunnelse for rettingsvindu"), "Retained reason"),
      Scene.type(Scene.label("Sluttidspunkt (med tidssone)"), "2031-09-14T15:00:00+02:00"),
      Scene.expect(Scene.selector("dialog")).toHaveAttr(
        "aria-describedby",
        "recruitment-correction-window-dialog-description",
      ),
      Scene.click(Scene.role("button", { name: "Tilbake" })),
      Scene.Command.resolveAllExact([Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()]),
      Scene.Mount.expectEnded(Dialog.AcquireResources),
      Scene.expectAll(Scene.all.selector("dialog[open]")).toBeEmpty(),
    );
  });

  it("shows authoritative refusal inside the dialog and keeps the exact draft for retry", () => {
    Scene.scene(
      config,
      Scene.given(staffingModel(closedObservation())),
      Scene.click(Scene.role("button", { name: "Gjenåpne retting" })),
      Scene.Command.resolveAllExact([Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()]),
      Scene.Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      Scene.type(Scene.label("Begrunnelse for rettingsvindu"), "Retained reason"),
      Scene.type(Scene.label("Sluttidspunkt (med tidssone)"), "2031-09-14T13:00:00Z"),
      Scene.click(Scene.role("button", { name: "Bekreft gjenåpning" })),
      Scene.Command.resolveAllExact([
        commands.Save,
        FailedSave({
          commandId: testCommandId,
          conflict: true,
          message: "Server refused stale sequence",
        }),
      ]),
      Scene.expect(Scene.role("alert")).toHaveText("Server refused stale sequence"),
      Scene.expect(Scene.label("Begrunnelse for rettingsvindu")).toHaveValue("Retained reason"),
      Scene.expect(Scene.label("Sluttidspunkt (med tidssone)")).toHaveValue("2031-09-14T13:00:00Z"),
      Scene.expect(Scene.role("button", { name: "Bekreft gjenåpning" })).toBeDisabled(),
      Scene.expectAll(
        Scene.all.role("button", { name: "Prøv samme forespørsel igjen" }),
      ).toBeEmpty(),
    );
  });

  it("Ordinary does not offer window maintenance merely because the staffing view is available", () => {
    const ordinary = AssessmentCorrection.cases.Ordinary.make({
      sequence: 0,
      canCorrect: false,
      canReopen: false,
      canClose: false,
    });

    Scene.scene(
      config,
      Scene.given({ ...staffingModel(ordinary), mutation: Mutation.cases.Idle.make({}) }),
      Scene.expect(Scene.role("button", { name: "Gjenåpne retting" })).toBeDisabled(),
      Scene.expect(Scene.role("button", { name: "Lukk rettingsvindu" })).toBeDisabled(),
    );
  });
});

const openerCases = [
  {
    name: "Gjenåpne retting",
    confirm: "Bekreft gjenåpning",
    observation: closedObservation,
    denied: () => closedObservation(false),
    index: 0,
    reopen: true,
  },
  {
    name: "Lukk rettingsvindu",
    confirm: "Bekreft lukking",
    observation: openObservation,
    denied: () => openObservation(false, false),
    index: 1,
    reopen: false,
  },
];

// Scene proves eligibility and update transitions, not DOM focus or modal isolation.
it.each(openerCases)("keeps $name eligible across open/close without allowing reentrant open", ({ name, observation }) => {
  const opener = Scene.role("button", { name });

  Scene.scene(
    config,
    Scene.given(staffingModel(observation())),
    Scene.expect(opener).toBeEnabled(),
    Scene.click(opener),
    Scene.Command.resolveAllExact([Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()]),
    Scene.Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
    Scene.expect(opener).toBeEnabled(),
    Scene.type(Scene.label("Begrunnelse for rettingsvindu"), "Retained draft"),
    // Scene has no native inert isolation: this deliberately reaches the existing update guard.
    Scene.click(opener),
    Scene.Command.expectNone(),
    Scene.expect(Scene.label("Begrunnelse for rettingsvindu")).toHaveValue("Retained draft"),
    Scene.click(Scene.role("button", { name: "Tilbake" })),
    Scene.Command.resolveAllExact([Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()]),
    Scene.Mount.expectEnded(Dialog.AcquireResources),
    Scene.expectAll(Scene.all.selector("dialog[open]")).toBeEmpty(),
    Scene.expect(opener).toBeEnabled(),
  );
});

it.each(openerCases)("keeps $name mutation-locked and applies server eligibility after reload", ({ name, confirm, observation, denied, reopen }) => {
  for (const conflict of [false, true]) {
    const opener = Scene.role("button", { name });

    Scene.scene(
      config,
      Scene.given(staffingModel(observation())),
      Scene.click(opener),
      Scene.Command.resolveAllExact([Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()]),
      Scene.Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      Scene.type(Scene.label("Begrunnelse for rettingsvindu"), "Retained draft"),
      ...(reopen ? [Scene.type(Scene.label("Sluttidspunkt (med tidssone)"), "2031-09-14T13:00:00Z")] : []),
      Scene.click(Scene.role("button", { name: confirm })),
      Scene.expect(opener).toBeDisabled(),
      Scene.expect(Scene.role("button", { name: "Gjenåpne retting" })).toBeDisabled(),
      Scene.expect(Scene.role("button", { name: "Lukk rettingsvindu" })).toBeDisabled(),
      Scene.expect(Scene.role("button", { name: "Tilbake" })).toBeDisabled(),
      Scene.Command.resolveAllExact([commands.Save, FailedSave({ commandId: testCommandId, conflict, message: "Window save refused" })]),
      Scene.expect(opener).toBeDisabled(),
      Scene.expect(Scene.role("button", { name: "Gjenåpne retting" })).toBeDisabled(),
      Scene.expect(Scene.role("button", { name: "Lukk rettingsvindu" })).toBeDisabled(),
      Scene.click(Scene.within(Scene.role("dialog", { name }), Scene.role("button", { name: "Last gjeldende versjon (erstatter utkast)" }))),
      Scene.Mount.expectEnded(Dialog.AcquireResources),
      Scene.expect(opener).toBeDisabled(),
      Scene.expect(Scene.role("button", { name: "Gjenåpne retting" })).toBeDisabled(),
      Scene.expect(Scene.role("button", { name: "Lukk rettingsvindu" })).toBeDisabled(),
      Scene.Command.resolveAllExact(
        [Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()],
        [commands.Load, SucceededStaffing({ requestId: 2, data: staffingModel(denied()).staffing!, commandId: testCommandId })],
      ),
      Scene.expect(opener).toBeDisabled(),
      Scene.click(Scene.role("button", { name: "Last gjeldende versjon (erstatter utkast)" })),
      Scene.expect(opener).toBeDisabled(),
      Scene.Command.resolveAllExact([commands.Load, SucceededStaffing({ requestId: 3, data: staffingModel(observation()).staffing!, commandId: testCommandId })]),
      Scene.expect(opener).toBeEnabled(),
    );
  }
});

// Reuses dashboard/keyboard.test.ts's real Runtime/native Dialog pattern in happy-dom.
// Chromium's unchanged full R2 remains the browser acceptance boundary.
it.each(openerCases)("returns native Dialog focus to $name after Escape and Tilbake, and releases on unmount", async ({ observation, index }) => {
  const host = document.createElement("div");
  const container = document.createElement("div");
  container.id = `correction-window-opener-test-${index}`;
  host.append(container);
  document.body.append(host);
  let calls = 0;
  const nativeCommands = testCommands(() => { calls += 1; });

  const handle = Runtime.embed(Runtime.makeElement({
    Model,
    container,
    init: () => ({ model: staffingModel(observation()), commands: [] }),
    update: updateFor(nativeCommands),
    view,
    devTools: false,
    slow: false,
  }));

  try {
    await vi.waitFor(() => expect(host.querySelectorAll('[aria-label="Rettingsvindu"] button')).toHaveLength(2));
    const opener = host.querySelectorAll<HTMLButtonElement>('[aria-label="Rettingsvindu"] button')[index]!;
    // User precondition only: happy-dom click does not focus a button. Never focus after dismissal.
    opener.focus();

    for (const dismissal of ["Escape", "Tilbake"] as const) {
      opener.click();
      await vi.waitFor(() => expect(host.querySelector("dialog[open]")).not.toBeNull());
      const cancel = host.querySelector<HTMLButtonElement>("dialog button")!;
      await vi.waitFor(() => expect(document.activeElement).toBe(cancel));
      expect(opener.disabled).toBe(false);
      expect(opener.closest("[inert]")).not.toBeNull();

      if (dismissal === "Escape") {
        cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      } else {
        cancel.click();
      }

      await vi.waitFor(() => expect(host.querySelector("dialog[open]")).toBeNull());
      await vi.waitFor(() => expect(document.activeElement).toBe(opener));
      expect(opener.closest("[inert]")).toBeNull();
      expect(host.querySelectorAll('[aria-label="Rettingsvindu"] button')[index]).toBe(opener);
      expect(document.body.style.overflow).not.toBe("hidden");
    }

    opener.click();
    await vi.waitFor(() => expect(document.activeElement).toBe(host.querySelector("dialog button")));
    handle.dispose();
    await vi.waitFor(() => {
      expect(container.isConnected).toBe(true);
      expect(container.childElementCount).toBe(0);
      expect(document.body.style.overflow).not.toBe("hidden");
      expect(container.closest("[inert]")).toBeNull();
    });
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    container.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(calls).toBe(0);
  } finally {
    handle.dispose();
    await vi.waitFor(() => expect(container.childElementCount).toBe(0));
    host.remove();
  }
});

// Transport fixture only: production Save/Load decode HTTP, production update/view,
// native CloseDialog and Dom.focus all execute. No test-created UI result messages.
const waitDom = (assertion: () => void) => Effect.promise(() => vi.waitFor(assertion));

const encodeStaffing = Schema.encodeSync(InterviewStaffingManagement);

const decodeMaintenanceJson = Schema.decodeUnknownSync(Schema.fromJsonString(RecruitmentMaintenanceCommand));

const encodeMaintenanceResult = Schema.encodeSync(RecruitmentMaintenanceResult);

const fixtureFetch = (canReopen = true, failReload = false) => {
  let closed = false;
  let posts = 0;

  const fetch: FetchCapability = (input, options) => Effect.runPromise(Effect.gen(function* () {
    const request = new Request(input, options);

    if (request.method === "POST") {
      const command = decodeMaintenanceJson(yield* Effect.promise(() => request.text()));

      if (!Predicate.isTagged(command, "CloseAssessmentCorrection"))
        return yield* Effect.die(new Error("Expected a CloseAssessmentCorrection command"));
      expect(command.commandId).toBe(request.headers.get("idempotency-key"));
      expect(command.interviewId).toBe(testInterviewId);
      posts++;
      closed = true;

      return Response.json(encodeMaintenanceResult(RecruitmentMaintenanceResult.cases.AssessmentCorrectionClosed.make({ interviewId: RecruitmentInterviewId.make(testInterviewId), sequence: 4 })), { headers: { etag: '"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"', "cache-control": "no-store", vary: "Origin" } });
    }

    expect(new URL(request.url).pathname).toBe("/api/recruitment/interview-staffing");

    if (closed && failReload) return yield* Effect.die(new TypeError("Synthetic offline reload"));
    const observation = closed ? AssessmentCorrection.cases.Closed.make({ sequence: 4, canCorrect: false, canClose: false, canReopen }) : openObservation();
    const data = staffingModel(observation).staffing!;
    const staffing = InterviewStaffingManagement.make({ ...data, interviews: [...data.interviews, { ...data.interviews[0]!, interviewId: RecruitmentInterviewId.make("another-current-interview"), assessmentCorrection: closedObservation() }] });

    return Response.json(encodeStaffing(staffing), { headers: { "cache-control": "private, no-store", vary: "Origin" } });
  }));

  return { fetch, posts: () => posts };
};

const clickNamed = (host: HTMLElement, name: string) => {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent === name);
  expect(button).toBeDefined();
  button!.click();
};

const submitClose = (host: HTMLElement) => Effect.gen(function* () {
  const opener = host.querySelectorAll<HTMLButtonElement>('[aria-label="Rettingsvindu"] button')[1]!;
  opener.focus(); // Only the user precondition; never focus after native close.
  expect(opener.disabled).toBe(false);
  opener.click();
  yield* waitDom(() => expect(host.querySelector("dialog[open]")).not.toBeNull());
  const reason = host.querySelector<HTMLTextAreaElement>("#rm-correction-reason")!;
  reason.value = "Finished correction";
  reason.dispatchEvent(new Event("input", { bubbles: true }));
  clickNamed(host, "Bekreft lukking");
});

itEffect.live.each(["success", "failed-reload", "no-reopen", "Escape", "Tilbake", "focus-selection", "focus-refresh", "focus-dispose", "load-dispose", "held-close-selection", "held-close-refresh", "close-dispose"] as const)("production-wired native workflow: %s", (scenario) => Effect.scoped(Effect.gen(function* () {
  const context = yield* Effect.context<Scope.Scope>();
  const saveGate = yield* Deferred.make<void>();
  const loadGate = yield* Deferred.make<void>();
  const focusGate = yield* Deferred.make<void>();
  const closeGate = yield* Deferred.make<void>();
  const loadStarted = yield* Deferred.make<void>();
  const loadReleased = yield* Deferred.make<void>();
  const focusStarted = yield* Deferred.make<void>();
  const focusReleased = yield* Deferred.make<void>();
  const closeStarted = yield* Deferred.make<void>();
  const closeReleased = yield* Deferred.make<void>();
  let loadRuns = 0;
  let focusRuns = 0;
  let focusResults = 0;
  let currentModel = staffingModel(openObservation());
  const transport = fixtureFetch(scenario !== "no-reopen", scenario === "failed-reload");
  let firstRead = true;

  const fetch: FetchCapability = (input, options) => {
    if (firstRead && options?.method === "GET") {
      firstRead = false;

      return Effect.runPromiseWith(context)(Effect.gen(function* () {
        yield* Deferred.succeed(loadStarted, undefined);
        yield* Deferred.await(loadGate);

        return yield* Effect.promise(() => transport.fetch(input, options));
      }), { signal: options?.signal ?? undefined });
    }

    return transport.fetch(input, options);
  };

  const commands = commandsFor(createEffectClient("http://workflow.test", { fetch }));
  const originalTransition = Object.getOwnPropertyDescriptor(document, "startViewTransition");
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: (update: () => void) => {
    const completion = Effect.runPromiseWith(context)(Deferred.await(focusGate).pipe(Effect.andThen(Effect.sync(update))));

    return { updateCallbackDone: completion, ready: completion, finished: completion,
      skipTransition: () => { Effect.runSyncWith(context)(Deferred.succeed(focusGate, undefined)); } };
  } });
  const productionUpdate = updateFor(commands);
  const host = document.createElement("div");
  const container = document.createElement("div");
  container.id = "native-workflow-production-" + scenario;
  host.append(container);
  document.body.append(host);

  const handle = Runtime.embed(Runtime.makeElement({ Model, container, init: () => ({ model: currentModel, commands: [] }), view, devTools: false, slow: false, viewTransition: ({ model }) => model.workflowFocus?.phase === "Focusing",
    update: (model, message) => {
      if (Predicate.isTagged(message, "CompletedWorkflowFocus")) focusResults++;
      const next = productionUpdate(model, message);
      currentModel = next.model;

      return { ...next, commands: (next.commands ?? []).map((command) => {
        if (command.name === "SaveRecruitmentMaintenance") return Command.mapEffect(command, (effect) => Deferred.await(saveGate).pipe(Effect.andThen(effect)));

        if (command.name === "LoadRecruitmentMaintenance") return Command.mapEffect(command, (effect) => Effect.gen(function* () {
          loadRuns++;

          // The HTTP gate lives inside the real registered Load, not before it.
          return yield* effect;
        }).pipe(Effect.ensuring(Deferred.succeed(loadReleased, undefined))));

        if (command.name === "FocusCorrectionReopen") return Command.mapEffect(command, (effect) => Effect.gen(function* () {
          focusRuns++;
          yield* Deferred.succeed(focusStarted, undefined);

          // Native Dom.focus is held by the browser transition before the actual commit.
          return yield* effect;
        }).pipe(Effect.ensuring(Deferred.succeed(focusReleased, undefined))));

        if (command.name === Dialog.CloseDialog.name && (scenario.startsWith("held-close") || scenario === "close-dispose" || scenario === "success" || scenario.startsWith("focus-"))) return Command.mapEffect(command, (effect) => Effect.gen(function* () {
          yield* Deferred.succeed(closeStarted, undefined);
          yield* Deferred.await(closeGate);

          return yield* effect;
        }).pipe(Effect.ensuring(Deferred.succeed(closeReleased, undefined))));

        return command;
      }) };
    },
  }));

  yield* Effect.addFinalizer(() => Effect.sync(() => { handle.dispose(); host.remove();

 if (originalTransition) Object.defineProperty(document, "startViewTransition", originalTransition); else Reflect.deleteProperty(document, "startViewTransition"); }));
  yield* waitDom(() => expect(host.querySelectorAll('[aria-label="Rettingsvindu"] button')).toHaveLength(2));
  const buttons = host.querySelectorAll<HTMLButtonElement>('[aria-label="Rettingsvindu"] button');
  const reopen = buttons[0]!;
  const close = buttons[1]!;
  yield* submitClose(host);
  yield* waitDom(() => expect(currentModel.mutation._tag).toBe("Pending"));
  clickNamed(host, "Tilbake");
  yield* waitDom(() => expect(host.querySelector("dialog[open]")).not.toBeNull());
  yield* Deferred.succeed(saveGate, undefined);
  yield* waitDom(() => expect(currentModel.mutation).toEqual(Mutation.cases.Saved.make({})));
  yield* Deferred.await(loadStarted);
  expect(currentModel.workflowFocus?.phase).toBe("Reloading");
  expect(reopen.disabled).toBe(true);
  expect(close.disabled).toBe(true);

  if (scenario === "load-dispose") {
    handle.dispose();
    yield* Deferred.await(loadReleased);
    yield* Deferred.succeed(loadGate, undefined);
    yield* waitDom(() => expect(container.childElementCount).toBe(0));
    expect(focusRuns).toBe(0);
    expect(document.body.style.overflow).not.toBe("hidden");

    return;
  }

  if (scenario === "Escape" || scenario === "Tilbake") {
    const cancel = host.querySelector<HTMLButtonElement>("dialog button")!;

    if (scenario === "Escape") cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    else cancel.click();
    yield* Deferred.await(loadReleased);
    yield* waitDom(() => expect(currentModel.status).toBe("Ready"));
    yield* Deferred.succeed(loadGate, undefined);
    expect(currentModel.workflowFocus).toBeNull();
    expect(focusRuns).toBe(0);
    expect(document.activeElement).not.toBe(reopen);
  } else {
    yield* Deferred.succeed(loadGate, undefined);
    yield* Deferred.await(loadReleased);
    yield* waitDom(() => expect(currentModel.status).toBe(scenario === "failed-reload" ? "Failed" : "Ready"));

    if (scenario === "failed-reload" || scenario === "no-reopen") {
      yield* waitDom(() => expect(host.querySelector("dialog[open]")).toBeNull());
      yield* waitDom(() => expect(currentModel.dialogClosing).toBe(false));
      expect(focusRuns).toBe(0);
      expect(document.activeElement).not.toBe(reopen);

      if (scenario === "failed-reload") expect(host.textContent).toContain("Opplysningene kunne ikke hentes");
      else expect(reopen.disabled).toBe(true);
    } else if (scenario.startsWith("held-close") || scenario === "close-dispose") {
      yield* Deferred.await(closeStarted);
      yield* waitDom(() => expect(reopen.disabled).toBe(false));

      if (scenario === "close-dispose") {
        handle.dispose();
        yield* Deferred.await(closeReleased);
        yield* Deferred.succeed(closeGate, undefined);
        yield* waitDom(() => expect(container.childElementCount).toBe(0));
        expect(focusRuns).toBe(0);

        return;
      }

      if (scenario === "held-close-selection") {
        const select = host.querySelector<HTMLSelectElement>("#rm-record")!;
        select.value = "another-current-interview";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      } else clickNamed(host, "Last gjeldende versjon (erstatter utkast)");
      yield* waitDom(() => { expect(currentModel.workflowFocus).toBeNull(); expect(currentModel.status).toBe("Ready"); });
      clickNamed(host, "Gjenåpne retting");
      expect(currentModel.correctionDialog.isOpen).toBe(false);
      expect(currentModel.dialogClosing).toBe(true);
      yield* Deferred.succeed(closeGate, undefined);
      yield* Deferred.await(closeReleased);
      yield* waitDom(() => { expect(currentModel.dialogClosing).toBe(false); expect(currentModel.cancellingFocus).toBeNull(); });
      clickNamed(host, "Gjenåpne retting");
      yield* waitDom(() => expect(host.querySelector("dialog[open]")).not.toBeNull());
      expect(focusRuns).toBe(0);
      clickNamed(host, "Tilbake");
      yield* waitDom(() => expect(host.querySelector("dialog[open]")).toBeNull());
    } else {
      yield* Deferred.await(closeStarted);
      yield* waitDom(() => expect(reopen.disabled).toBe(false));
      yield* Deferred.succeed(closeGate, undefined);
      yield* Deferred.await(focusStarted);
      yield* waitDom(() => { expect(reopen.disabled).toBe(false); expect(host.querySelector("dialog[open]")).toBeNull(); });
      expect(currentModel.workflowFocus?.phase).toBe("Focusing");

      if (scenario === "focus-dispose") handle.dispose();
      else if (scenario === "focus-selection") {
        const select = host.querySelector<HTMLSelectElement>("#rm-record")!;
        select.value = "another-current-interview";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (scenario === "focus-refresh") clickNamed(host, "Last gjeldende versjon (erstatter utkast)");
      else yield* Deferred.succeed(focusGate, undefined);
      yield* Deferred.await(focusReleased);

      if (scenario === "success") {
        yield* waitDom(() => expect(document.activeElement).toBe(reopen));
        yield* waitDom(() => expect(focusResults).toBe(1));
        expect(host.querySelectorAll('[aria-label="Rettingsvindu"] button')[0]).toBe(reopen);
        expect(host.querySelectorAll('[aria-label="Rettingsvindu"] button')[1]).toBe(close);
        expect(close.disabled).toBe(true);
      } else {
        yield* Deferred.succeed(focusGate, undefined);
        expect(focusResults).toBe(0);
        expect(document.activeElement).not.toBe(reopen);
      }
    }
  }

  expect(transport.posts()).toBe(1);
  handle.dispose();
  yield* waitDom(() => { expect(container.childElementCount).toBe(0); expect(document.body.style.overflow).not.toBe("hidden"); });
})), 15000);

let activeRouteFetch: FetchCapability | undefined;

const routeFetch: FetchCapability = (input, options) => {
  if (activeRouteFetch === undefined) throw new Error("Route transport called outside its test owner");

  return activeRouteFetch(input, options);
};

// Actual route -> registered custom element -> production embed -> Runtime.dispose.
itEffect.live.each(["pending-destination", "query-replacement", "history-pop", "element-unmount", "revalidation"] as const)("real route/custom-element teardown: %s", (scenario) => Effect.scoped(Effect.gen(function* () {
  const context = yield* Effect.context<Scope.Scope>();
  const reloadGate = yield* Deferred.make<void>();
  const reloadStarted = yield* Deferred.make<void>();
  const reloadReleased = yield* Deferred.make<void>();
  const destinationGate = yield* Deferred.make<void>();
  const transport = fixtureFetch();
  let reloadSignal: AbortSignal | null | undefined;
  let reloadWasAborted = false;

  const fetch: FetchCapability = (input, options) => {
    const request = new Request(input, options);

    if (request.method === "GET" && transport.posts() > 0) {
      reloadSignal = options?.signal;

      return Effect.runPromiseWith(context)(Effect.gen(function* () {
        yield* Deferred.succeed(reloadStarted, undefined);
        yield* Deferred.await(reloadGate);

        return yield* Effect.promise(() => transport.fetch(input, options));
      }).pipe(Effect.ensuring(Effect.gen(function* () {
        reloadWasAborted = reloadSignal?.aborted ?? false;
        yield* Deferred.succeed(reloadReleased, undefined);
      }))), { signal: options?.signal ?? undefined });
    }

    return transport.fetch(input, options);
  };

  activeRouteFetch = fetch;
  vi.stubGlobal("fetch", routeFetch);
  vi.stubEnv("VITE_API_URL", "http://workflow.test");
  vi.stubGlobal("location", { origin: "http://workflow.test" });
  registerRecruitmentMaintenanceElements();
  const host = document.createElement("div");
  document.body.append(host);
  const reactRoot = createRoot(host);

  const router = createMemoryRouter([
    { path: "/staffing", Component: Intervjubemanning, loader: () => null },
    { path: "/other", loader: ({ request }) => Effect.runPromiseWith(context)(Deferred.await(destinationGate), { signal: request.signal }), Component: () => createElement("p", null, "Destination") },
  ], { initialEntries: scenario === "history-pop" ? ["/other", "/staffing"] : ["/staffing"], initialIndex: scenario === "history-pop" ? 1 : 0 });

  reactRoot.render(createElement(RouterProvider, { router }));
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    const ownedElement = host.querySelector(STAFFING_ELEMENT);
    reactRoot.unmount(); router.dispose();
    yield* waitDom(() => { expect(document.body.style.overflow).not.toBe("hidden");

 if (ownedElement) expect(ownedElement.querySelector(".recruitment-maintenance")).toBeNull(); });
    host.remove(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  }));
  yield* waitDom(() => expect(host.querySelector("#rm-record option[value='" + testInterviewId + "']")).not.toBeNull());
  const element = host.querySelector(STAFFING_ELEMENT)!;
  const select = host.querySelector<HTMLSelectElement>("#rm-record")!;
  select.value = testInterviewId;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  yield* waitDom(() => expect(host.querySelectorAll('[aria-label="Rettingsvindu"] button')).toHaveLength(2));
  const reopen = host.querySelectorAll<HTMLButtonElement>('[aria-label="Rettingsvindu"] button')[0]!;
  yield* submitClose(host);
  yield* Deferred.await(reloadStarted);
  expect(host.querySelector("dialog[open]")).not.toBeNull();

  if (scenario === "revalidation") {
    yield* Effect.promise(() => router.revalidate());
    yield* waitDom(() => expect(router.state.revalidation).toBe("idle"));
    expect(host.querySelector(STAFFING_ELEMENT)).toBe(element);
    expect(reloadSignal?.aborted).toBe(false);
    yield* Deferred.succeed(reloadGate, undefined);
    yield* Deferred.await(reloadReleased);
    yield* waitDom(() => expect(document.activeElement).toBe(reopen));
  } else {
    if (scenario === "element-unmount") reactRoot.unmount();
    else {
      const navigation = scenario === "history-pop" ? router.navigate(-1) : router.navigate(scenario === "query-replacement" ? "/staffing?replacement=1" : "/other");
      yield* Deferred.await(reloadReleased);
      expect(reloadWasAborted).toBe(true);
      expect(element.isConnected).toBe(false);

      if (scenario !== "query-replacement") expect(router.state.navigation.state).not.toBe("idle");
      yield* Deferred.succeed(destinationGate, undefined);
      yield* Deferred.succeed(reloadGate, undefined);
      yield* Effect.promise(() => navigation);
    }

    yield* Deferred.await(reloadReleased);
    expect(reloadWasAborted).toBe(true);
    expect(element.isConnected).toBe(false);
    yield* Deferred.succeed(reloadGate, undefined);
    yield* waitDom(() => expect(document.body.style.overflow).not.toBe("hidden"));
    expect(document.activeElement).not.toBe(reopen);
  }
})), 15000);

itEffect.live.each([" leading spaces ", 'quote"[selector]\\slash', "norsk ø 😀", "lone-\ud800"])("native current Reopen target handles declared string identity: %s", (interviewId) => Effect.scoped(Effect.gen(function* () {
  const source = staffingModel(closedObservation());
  const model: Model = { ...source, selectedId: interviewId, staffing: InterviewStaffingManagement.make({ ...source.staffing!, interviews: [{ ...source.staffing!.interviews[0]!, interviewId: RecruitmentInterviewId.make(interviewId) }] }) };
  const ticket = { interviewId, requestId: model.requestId, commandId: model.commandId };
  const host = document.createElement("div");
  const container = document.createElement("div");
  container.id = "declared-reopen-identity-" + correctionReopenTarget(interviewId).id;
  host.append(container); document.body.append(host);
  const activeBeforeConstruction = document.activeElement;
  FocusCorrectionReopen(ticket); // Deliberately discard this Command.
  expect(document.activeElement).toBe(activeBeforeConstruction);
  const handle = Runtime.embed(Runtime.makeElement({ Model, container, init: () => ({ model, commands: [FocusCorrectionReopen(ticket)] }), update: updateFor(testCommands()), view, devTools: false, slow: false }));
  yield* Effect.addFinalizer(() => Effect.sync(() => { handle.dispose(); host.remove(); }));
  const target = correctionReopenTarget(interviewId);
  yield* waitDom(() => {
    const reopen = host.querySelector<HTMLButtonElement>(target.selector);
    expect(reopen?.id).toBe(target.id);
    expect(reopen?.textContent).toBe("Gjenåpne retting");
    expect(document.activeElement).toBe(reopen);
    expect(host.querySelectorAll('[aria-label="Rettingsvindu"] button')[1]?.textContent).toBe("Lukk rettingsvindu");
  });
})), 15000);


