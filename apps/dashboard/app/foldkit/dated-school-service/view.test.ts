// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { Schema } from "effect";
import { embedDatedService } from "./main";
import { Input } from "./model";

it("keeps evidence input focused across the cancellation render and submits its entered value", async () => {
  const input = Schema.decodeUnknownSync(Input)({
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
          commitmentId: `school-service-commitment-${"1".repeat(64)}`,
          proposalId: `school-service-proposal-${"2".repeat(64)}`,
          departmentId: "department",
          semesterId: "semester",
          schoolId: 1,
          schoolName: "School",
          day: "Monday",
          block: "2",
          serviceDate: "2031-03-24",
          startTime: "09:00",
          endTime: "11:00",
          requiredVolunteers: 2,
          assignments: [],
          createdAt: "2031-01-01T00:00:00.000Z",
          createdBy: "person",
          decision: null,
          overdue: false,
        },
      ],
      absences: [],
      candidates: [],
      offers: [],
      responses: [],
      acknowledgements: [],
      closures: [],
      dispatchNotifications: [],
      occurrences: [],
    },
  });

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
    const evidence = document.querySelector<HTMLInputElement>('input[name="evidenceSource"]')!;
    evidence.focus();

    // The outcome message is synchronous; its DOM patch occurs on the next frame.
    await vi.waitFor(() => expect(document.querySelector("textarea")?.disabled).toBe(false));
    expect(document.activeElement).toBe(evidence);
    evidence.value = "School contact, telephone confirmation";
    evidence.dispatchEvent(new Event("input", { bubbles: true }));
    const reason = document.querySelector("textarea")!;
    reason.value = "The school cancelled this service";
    reason.dispatchEvent(new Event("input", { bubbles: true }));

    await vi.waitFor(() =>
      expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(
        false,
      ),
    );
    const payload = new FormData(document.querySelector("form")!);
    expect(payload.get("action")).toBe("CancelService");
    expect(payload.get("evidenceSource")).toBe(evidence.value);
    expect(payload.get("reason")).toBe(reason.value);
    expect(payload.getAll("attendedPersonId")).toEqual([]);
  } finally {
    dispose();
    await vi.waitFor(() => expect(document.querySelector(".dated-service")).toBeNull());
    document.getElementById("dated-service-focus-test")?.remove();
  }
});
