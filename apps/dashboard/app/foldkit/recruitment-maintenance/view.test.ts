// @vitest-environment happy-dom
import { Dialog } from "@foldkit/ui";
import { AssessmentCorrection } from "@vektorprogrammet/domain/recruitment";
import { Runtime } from "foldkit";
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

