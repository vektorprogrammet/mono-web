import { describe, expect, it } from "vitest";
import {
  mapAdmissionPeriodError,
  mapAdmissionPeriodView,
  parseAdmissionPeriodForm,
} from "./admission-period-view";

const createForm = (overrides: Readonly<Record<string, string>> = {}): FormData => {
  const values = {
    _intent: "create",
    commandId: "",
    semesterId: "semester-autumn-2031",
    departmentId: "",
    startAt: "2031-08-15T08:00",
    endAt: "2031-10-01T20:00",
    ...overrides,
  };
  const form = new FormData();
  for (const [name, value] of Object.entries(values)) form.set(name, value);
  return form;
};

describe("admission-period dashboard boundary", () => {
  it("strictly decodes create fields and supplies the stable fallback command ID", () => {
    const parsed = parseAdmissionPeriodForm(createForm(), "command-create-1");

    expect("value" in parsed).toBe(true);
    if (!("value" in parsed) || parsed.value._tag !== "CreateAdmissionPeriod") return;
    expect(parsed.value.commandId).toBe("command-create-1");
    expect(parsed.value.draft).toEqual({
      semesterId: "semester-autumn-2031",
      departmentId: "",
      startAt: "2031-08-15T08:00",
      endAt: "2031-10-01T20:00",
    });
    expect(parsed.value.input).toEqual({
      commandId: "command-create-1",
      semesterId: "semester-autumn-2031",
      startAt: "2031-08-15T08:00:00.000Z",
      endAt: "2031-10-01T20:00:00.000Z",
    });
  });

  it("rejects excess form fields without losing the entered values", () => {
    const form = createForm();
    form.set("actorDepartmentId", "browser-asserted-department");
    const parsed = parseAdmissionPeriodForm(form, "command-create-2");

    expect("failure" in parsed).toBe(true);
    if (!("failure" in parsed) || parsed.failure.intent !== "create") return;
    expect(parsed.failure.commandId).toBe("command-create-2");
    expect(parsed.failure.error._tag).toBe("AdmissionPeriodFormError");
    expect(parsed.failure.draft.semesterId).toBe("semester-autumn-2031");
    expect(parsed.failure.draft.startAt).toBe("2031-08-15T08:00");
  });

  it("rejects a reversed window and preserves both instants for correction", () => {
    const parsed = parseAdmissionPeriodForm(
      createForm({
        startAt: "2031-10-01T20:00",
        endAt: "2031-08-15T08:00",
      }),
      "command-create-3",
    );

    expect("failure" in parsed).toBe(true);
    if (!("failure" in parsed) || parsed.failure.intent !== "create") return;
    expect(parsed.failure.error).toMatchObject({
      _tag: "AdmissionPeriodFormError",
      field: "endAt",
    });
    expect(parsed.failure.draft).toMatchObject({
      startAt: "2031-10-01T20:00",
      endAt: "2031-08-15T08:00",
    });
  });

  it("decodes a revision with optimistic revision and stable identity", () => {
    const form = new FormData();
    form.set("_intent", "revise");
    form.set("commandId", "command-revise-1");
    form.set("admissionPeriodId", "admission-period-1");
    form.set("expectedRevision", "4");
    form.set("startAt", "2031-08-15T08:00");
    form.set("endAt", "2031-08-31T12:00");

    const parsed = parseAdmissionPeriodForm(form, "unused-fallback");

    expect("value" in parsed).toBe(true);
    if (!("value" in parsed) || parsed.value._tag !== "ReviseAdmissionPeriod") return;
    expect(parsed.value).toMatchObject({
      admissionPeriodId: "admission-period-1",
      expectedRevision: 4,
      commandId: "command-revise-1",
    });
    expect(parsed.value.input.endAt).toBe("2031-08-31T12:00:00.000Z");
  });

  it("keeps canonical SDK rejection tags visible to the interface", () => {
    expect(
      mapAdmissionPeriodError({ admissionPeriodTag: "AdmissionScopeDenied" }),
    ).toEqual({
      _tag: "AdmissionScopeDenied",
      message: "Du har ikke tilgang til opptaksperioder for denne avdelingen.",
      field: "departmentId",
    });
    expect(
      mapAdmissionPeriodError({ _tag: "StaleAdmissionPeriodRevision" }),
    ).toMatchObject({
      _tag: "StaleAdmissionPeriodRevision",
      field: "expectedRevision",
    });
  });

  it("maps decoded SDK dates to deterministic UTC display values", () => {
    const view = mapAdmissionPeriodView({
      id: "admission-period-1",
      departmentId: "department-trondheim",
      semesterId: "semester-autumn-2031",
      startAt: "2031-08-15T08:00:00.000Z",
      endAt: "2031-10-01T20:00:00.000Z",
      revision: 0,
      lastCommandId: "command-create-1",
      eligible: true,
    });

    expect(view).toMatchObject({
      id: "admission-period-1",
      startAt: "2031-08-15T08:00:00.000Z",
      startAtInput: "2031-08-15T08:00",
      endAt: "2031-10-01T20:00:00.000Z",
      endAtInput: "2031-10-01T20:00",
      revision: 0,
      eligible: true,
    });
  });
});
