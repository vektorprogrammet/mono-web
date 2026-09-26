// @vitest-environment happy-dom
import { Schema } from "effect";
import { Scene } from "foldkit/test";
import { describe, expect, it, vi } from "vitest";
import { embedDatedService } from "./main";
import { Input, init } from "./model";
import { update } from "./update";
import { view } from "./view";

const commitmentId = `school-service-commitment-${"1".repeat(64)}`;

const proposalId = `school-service-proposal-${"2".repeat(64)}`;

const absenceId = `school-service-absence-${"3".repeat(64)}`;

const slot = { schoolId: 1, schoolName: "School", day: "Monday", block: "2" } as const;

const assignment = (digit: string, personId: string, firstName: string, lastName: string) => ({
  placementId: `placement-${digit.repeat(64)}`,
  personId,
  firstName,
  lastName,
  ...slot,
});

const adaAbsence = {
  absenceId,
  commitmentId,
  proposalId,
  departmentId: "department",
  semesterId: "semester",
  personId: "person-ada",
  ...slot,
  serviceDate: "2031-03-24",
  reporterPersonId: "person-ada",
  reportedAt: "2031-03-20T08:00:00.000Z",
};

const siriCoversAda = {
  coverageId: `school-service-coverage-${"4".repeat(64)}`,
  absenceId,
  coveringPersonId: "person-siri",
  coveringFirstName: "Siri",
  coveringLastName: "Vikar",
  covererKind: "Substitute",
  recordedByPersonId: "person-ada",
  recordedAt: "2031-03-21T08:00:00.000Z",
};

const completed = {
  outcome: "Completed",
  decidedAt: "2031-03-24T12:00:00.000Z",
  decidedBy: "person-leader",
  evidenceSource: "Skolens kontaktlærer",
  reason: null,
  attendedPersonIds: ["person-bo", "person-siri"],
  occurrenceId: `school-service-occurrence-${"7".repeat(64)}`,
};

const roster = [
  assignment("5", "person-ada", "Ada", "Assistent"),
  assignment("6", "person-bo", "Bo", "Berg"),
];

type Service = {
  readonly requiredVolunteers: number;
  readonly assignments: typeof roster;
  readonly absences: ReadonlyArray<typeof adaAbsence>;
  readonly coverage: ReadonlyArray<typeof siriCoversAda>;
  readonly overdue: boolean;
  readonly decision: typeof completed | null;
};

/** Ada and Bo are scheduled for a service that needs two; Ada is absent and Siri covers her. */
const covered: Service = {
  requiredVolunteers: 2,
  assignments: roster,
  absences: [adaAbsence],
  coverage: [siriCoversAda],
  overdue: true,
  decision: null,
};

const coordinatorInput = (service: Service) =>
  Schema.decodeUnknownSync(Input)({
    departmentId: "department",
    semesterId: "semester",
    board: null,
    ownCoverage: null,
    coverage: {
      departmentId: "department",
      semesterId: "semester",
      etag: `"vkr2.${"A".repeat(43)}"`,
      rosterAssignments: [],
      commitments: [
        {
          commitmentId,
          proposalId,
          departmentId: "department",
          semesterId: "semester",
          ...slot,
          serviceDate: "2031-03-24",
          startTime: "09:00",
          endTime: "11:00",
          requiredVolunteers: service.requiredVolunteers,
          assignments: service.assignments,
          createdAt: "2031-01-01T00:00:00.000Z",
          createdBy: "person",
          decision: service.decision,
          overdue: service.overdue,
        },
      ],
      absences: service.absences,
      coverage: service.coverage,
      coverers: [],
      closures: [],
      occurrences: [],
    },
  });

const openDecision = Scene.click(
  Scene.role("button", { name: "Registrer beslutning for denne datoen" }),
);

const attendance = Scene.role("list", { name: "Beregnet oppmøte" });

const outcome = Scene.role("combobox");

const evidence = Scene.label("Kilde for dokumentasjonen");

const reason = Scene.label("Begrunnelse");

const save = Scene.role("button", { name: "Lagre uforanderlig beslutning" });

describe("dated service decision", () => {
  it("counts the covering person in place of the absent assistant", () => {
    Scene.scene(
      { update, view },
      Scene.given(init(coordinatorInput(covered))),
      openDecision,
      Scene.expect(attendance).toContainText("Bo Berg (planlagt frivillig)"),
      Scene.expect(attendance).toContainText("Siri Vikar (dekker fravær)"),
      Scene.expect(attendance).not.toContainText("Ada Assistent"),
      Scene.expect(Scene.text("2 møter av 2 som trengs.")).toExist(),
      Scene.expect(save).toBeDisabled(),
      Scene.type(evidence, "Skolens kontaktlærer"),
      Scene.expect(save).toBeEnabled(),
      Scene.change(outcome, "MarkUnfulfilledService"),
      Scene.type(evidence, "Skolens kontaktlærer"),
      Scene.type(reason, "Bare én møtte"),
      Scene.expect(save).toBeDisabled(),
    );
  });

  it("lowers the count for an uncovered absence so only Ikke oppfylt fits", () => {
    Scene.scene(
      { update, view },
      Scene.given(init(coordinatorInput({ ...covered, coverage: [] }))),
      openDecision,
      Scene.expect(attendance).toContainText("Bo Berg (planlagt frivillig)"),
      Scene.expect(attendance).not.toContainText("Ada Assistent"),
      Scene.expect(Scene.text("1 møter av 2 som trengs.")).toExist(),
      Scene.type(evidence, "Skolens kontaktlærer"),
      Scene.expect(save).toBeDisabled(),
      Scene.change(outcome, "MarkUnfulfilledService"),
      Scene.type(evidence, "Skolens kontaktlærer"),
      Scene.expect(save).toBeDisabled(),
      Scene.type(reason, "Ada meldte fravær, og ingen dekket"),
      Scene.expect(save).toBeEnabled(),
    );
  });

  it("keeps Gjennomført closed until the service interval is over", () => {
    Scene.scene(
      { update, view },
      Scene.given(init(coordinatorInput({ ...covered, overdue: false }))),
      openDecision,
      Scene.type(evidence, "Skolens kontaktlærer"),
      Scene.expect(save).toBeDisabled(),
    );
  });

  it("names the attendees of a decided service from the roster and the coverage record", () => {
    const attended = Scene.role("list", { name: "Faktisk møtte" });

    Scene.scene(
      { update, view },
      Scene.given(init(coordinatorInput({ ...covered, decision: completed }))),
      Scene.expect(attended).toContainText("Bo Berg"),
      Scene.expect(attended).toContainText("Siri Vikar"),
    );
  });
});

it("keeps evidence input focused across the cancellation render and submits its entered value", async () => {
  const input = coordinatorInput({ ...covered, assignments: [], absences: [], coverage: [], overdue: false });
  const container = document.createElement("div");
  container.id = "dated-service-focus-test";
  document.body.append(container);
  const dispose = embedDatedService(container, input);

  try {
    await vi.waitFor(() => expect(document.querySelector("button")).not.toBeNull());
    document.querySelector("button")!.click();
    await vi.waitFor(() => expect(document.querySelector("select")).not.toBeNull());
    const select = document.querySelector("select")!;
    select.value = "CancelService";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const evidenceInput = document.querySelector<HTMLInputElement>('input[name="evidenceSource"]')!;
    evidenceInput.focus();

    // The outcome message is synchronous; its DOM patch occurs on the next frame.
    await vi.waitFor(() => expect(document.querySelector("textarea")?.disabled).toBe(false));
    expect(document.activeElement).toBe(evidenceInput);
    evidenceInput.value = "School contact, telephone confirmation";
    evidenceInput.dispatchEvent(new Event("input", { bubbles: true }));
    const reasonInput = document.querySelector("textarea")!;
    reasonInput.value = "The school cancelled this service";
    reasonInput.dispatchEvent(new Event("input", { bubbles: true }));

    await vi.waitFor(() =>
      expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(
        false,
      ),
    );
    const payload = new FormData(document.querySelector("form")!);
    expect(payload.get("mode")).toBe("coverage");
    expect(payload.get("action")).toBe("CancelService");
    expect(payload.get("evidenceSource")).toBe(evidenceInput.value);
    expect(payload.get("reason")).toBe(reasonInput.value);
  } finally {
    dispose();
    await vi.waitFor(() => expect(document.querySelector(".dated-service")).toBeNull());
    document.getElementById("dated-service-focus-test")?.remove();
  }
});
