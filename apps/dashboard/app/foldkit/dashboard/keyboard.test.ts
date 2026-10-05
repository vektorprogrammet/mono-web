// @vitest-environment happy-dom
import { Disclosure } from "@foldkit/ui";
import { IdempotencyKey, RecruitmentAssignmentBoardSchema } from "@vektorprogrammet/http-api";
import { Effect, Schema as S } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { RecruitmentClient } from "../recruitment/browser-client";
import { embedRecruitment } from "../recruitment/main";
import { LoadedRecruitmentInput, RecruitmentInputJson } from "../recruitment/model";
import { embedDashboard } from "./main";
import { DashboardInputJson, LandingSummary } from "./model";

const board = S.decodeSync(RecruitmentAssignmentBoardSchema)({
  admissionPeriodId: "admission-period-autumn-2031",
  departmentId: "department-trondheim",
  candidates: [{
    applicationId: "application-ada", applicantId: "applicant-ada",
    firstName: "Ada", lastName: "Lovelace", email: "ada@example.invalid",
    submittedAt: "2031-09-02T09:00:00.000Z", applicationState: "Received",
    interviewState: "Unassigned", interviewer: null, interviewSchema: null, scheduledAt: null,
  }],
  interviewers: [{ personId: "person-grace", displayName: "Grace Hopper" }],
  interviewSchemas: [{ interviewSchemaId: "schema-first", name: "Førstegangsintervju", questionCount: 8, active: true, revision: 0 }],
});

const recruitment = LoadedRecruitmentInput.make({ status: "all", board });

const unexpectedRequest = () => Effect.die("keyboard regression must not submit a server command");

const client: RecruitmentClient = {
  recruitment: {
    readAssignmentBoard: unexpectedRequest, createApplicationInterview: unexpectedRequest,
    readSchedulingBoard: unexpectedRequest, scheduleInterview: unexpectedRequest,
    readInterviewConduct: unexpectedRequest, finalizeInterview: unexpectedRequest,
    cancelInterview: unexpectedRequest, correctInterviewAssessment: unexpectedRequest,
  }
};

const admissionSelector = `#${Disclosure.buttonId("fd-admission-menu")}`;

const profileSelector = `#${Disclosure.buttonId("fd-profile-menu")}`;

const toggleSelector = "#fd-mobile-navigation-toggle";

const required = <E extends HTMLElement>(container: HTMLElement, selector: string): E => {
  const element = container.querySelector<E>(selector);

  expect(element, selector).not.toBeNull();

  return element!;
};

const press = (target: HTMLElement, key: string, shiftKey = false) => {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event);

  return event;
};

type ShellFixture = { readonly container: HTMLElement; readonly mountpoint: HTMLElement; readonly dispose: () => void };

const mountShell = (): ShellFixture => {
  const container = document.createElement("div");
  const mountpoint = document.createElement("div");
  mountpoint.id = "shell-keyboard-test";
  container.append(mountpoint);
  document.body.append(container);

  const dispose = embedDashboard(mountpoint, S.encodeSync(DashboardInputJson)({
    user: { name: "Ada Lovelace", avatar: null }, role: "ROLE_TEAM_MEMBER",
    activePath: "/dashboard/sokere", summary: LandingSummary.make({}), recruitment, scheduling: null,
  }));

  return { container, mountpoint, dispose };
};

const removeShell = async (shell: ShellFixture) => {
  shell.dispose();

  await vi.waitFor(() => {
    expect(shell.mountpoint.isConnected).toBe(true);
    expect(shell.container.querySelector(".foldkit-dashboard")).toBeNull();
  });
  shell.container.remove();
};

// Real bubbling and document-level native Dialog arbitration cannot be proven by Scene.
describe("shell keyboard event ownership", () => {
  it.each([
    ["admission", admissionSelector, '.fd-nav-submenu a'],
    ["profile", profileSelector, '.fd-profile__menu a'],
  ])("dismisses %s from a descendant and returns focus to its trigger", async (_name, triggerSelector, descendantSelector) => {
    const shell = mountShell();

    try {
      await vi.waitFor(() => expect(shell.container.querySelector(admissionSelector)).not.toBeNull());

      const trigger = required<HTMLButtonElement>(shell.container, triggerSelector);

      if (trigger.getAttribute("aria-expanded") !== "true") {
        trigger.click();
        await vi.waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
      }

      const descendant = required(shell.container, descendantSelector);
      descendant.focus();
      expect(press(descendant, "Tab").defaultPrevented).toBe(false);
      expect(press(descendant, "Escape").defaultPrevented).toBe(true);

      await vi.waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
      expect(document.activeElement).toBe(trigger);
      trigger.click();

      await vi.waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
      trigger.click();

      await vi.waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
      expect(press(trigger, "Escape").defaultPrevented).toBe(false);
    } finally { await removeShell(shell); }
  });

  it.each(["#fd-mobile-navigation-close", ".fd-mobile-overlay", toggleSelector])(
    "dismisses mobile navigation at %s and returns focus to the mobile toggle", async (selector) => {
      const shell = mountShell();

      try {
        await vi.waitFor(() => expect(shell.container.querySelector(toggleSelector)).not.toBeNull());

        const toggle = required<HTMLButtonElement>(shell.container, toggleSelector);
        toggle.click();
        await vi.waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));

        const target = required(shell.container, selector);
        target.focus();
        expect(press(target, "Tab").defaultPrevented).toBe(false);
        expect(press(target, "Escape").defaultPrevented).toBe(true);

        await vi.waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
        expect(document.activeElement).toBe(toggle);
        expect(required<HTMLButtonElement>(shell.container, ".fd-mobile-overlay").hidden).toBe(true);
        expect(press(toggle, "Escape").defaultPrevented).toBe(false);
        toggle.click();

        await vi.waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
        required<HTMLButtonElement>(shell.container, ".fd-mobile-overlay").click();

        await vi.waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
        expect(document.activeElement).toBe(toggle);
      } finally { await removeShell(shell); }
    },
  );

  it("does not consume content Escape even while mobile navigation is open", async () => {
    const shell = mountShell();

    try {
      await vi.waitFor(() => expect(shell.container.querySelector(toggleSelector)).not.toBeNull());

      const toggle = required<HTMLButtonElement>(shell.container, toggleSelector);
      toggle.click();
      await vi.waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));

      const main = required(shell.container, "#fd-main");
      main.focus();
      expect(press(main, "Escape").defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(main);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(required(shell.container, admissionSelector).getAttribute("aria-expanded")).toBe("true");
    } finally { await removeShell(shell); }
  });

  it("leaves one Escape to the actual nested recruitment Dialog and retains navigation", async () => {
    const shell = mountShell();
    let disposeRecruitment: (() => void) | undefined;

    try {
      await vi.waitFor(() => expect(shell.container.querySelector("#fd-recruitment-program")).not.toBeNull());

      const child = required(shell.container, "#fd-recruitment-program");

      disposeRecruitment = embedRecruitment(child, {
        client, serializedInput: S.encodeSync(RecruitmentInputJson)(recruitment),
        idempotencyKeySeed: IdempotencyKey.make("shell-keyboard-test-command"),
      });

      await vi.waitFor(() => expect(shell.container.querySelector(".fr-button--compact")).not.toBeNull());

      const opener = required<HTMLButtonElement>(shell.container, ".fr-button--compact");
      opener.focus();
      opener.click();

      await vi.waitFor(() => expect(shell.container.querySelector("dialog[open]")).not.toBeNull());
      await vi.waitFor(() => expect(document.activeElement).toBe(shell.container.querySelector("select")));

      const first = required<HTMLSelectElement>(shell.container, "select");
      // No select popup has been opened: this is the same first Escape owner seam as R8.
      press(first, "Escape");

      await vi.waitFor(() => expect(shell.container.querySelector("dialog[open]")).toBeNull());
      await vi.waitFor(() => expect(document.activeElement).toBe(opener));
      expect(required(shell.container, admissionSelector).getAttribute("aria-expanded")).toBe("true");
      expect(required<HTMLButtonElement>(shell.container, ".fd-mobile-overlay").hidden).toBe(true);
      expect(document.body.style.overflow).not.toBe("hidden");

      // Reopening and disposing while open exercises the library-owned cleanup backstop.
      opener.click();

      await vi.waitFor(() => expect(document.activeElement).toBe(shell.container.querySelector("select")));
      disposeRecruitment();
      disposeRecruitment = undefined;

      await vi.waitFor(() => {
        expect(child.isConnected).toBe(true);
        expect(child.childElementCount).toBe(0);
      });

      await vi.waitFor(() => expect(document.body.style.overflow).not.toBe("hidden"));

      const main = required(shell.container, "#fd-main");
      main.focus();
      expect(press(main, "Escape").defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(main);
      expect(required(shell.container, admissionSelector).getAttribute("aria-expanded")).toBe("true");
    } finally {
      disposeRecruitment?.();
      await removeShell(shell);
    }
  });
});
