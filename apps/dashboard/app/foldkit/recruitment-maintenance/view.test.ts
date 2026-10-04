import { Dialog } from "@foldkit/ui";
import { AssessmentCorrection } from "@vektorprogrammet/domain/recruitment";
import { Scene } from "foldkit/test";
import { describe, it } from "vitest";
import { FailedSave } from "./message";
import { Mutation } from "./model";
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
