import {
  AdmissionPeriodManagementItem,
  StrongETag,
  makeNativeProblem,
} from "@vektorprogrammet/http-api";
import { Schema } from "effect";
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

const createCommandId = "A".repeat(22);
const reviseCommandId = "B".repeat(22);
const periodEtag = StrongETag.make('"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"');

describe("admission-period dashboard boundary", () => {
  it("keeps local correlation outside the canonical create payload", () => {
    const parsed = parseAdmissionPeriodForm(createForm(), createCommandId);

    expect("value" in parsed).toBe(true);
    if (!("value" in parsed) || parsed.value._tag !== "CreateAdmissionPeriod") return;
    expect(parsed.value.commandId).toBe(createCommandId);
    expect(parsed.value.draft).toEqual({
      semesterId: "semester-autumn-2031",
      departmentId: "",
      startAt: "2031-08-15T08:00",
      endAt: "2031-10-01T20:00",
    });
    expect(parsed.value.payload).toEqual({
      semesterId: "semester-autumn-2031",
      startAt: "2031-08-15T08:00:00.000Z",
      endAt: "2031-10-01T20:00:00.000Z",
    });
    expect(parsed.value.payload).not.toHaveProperty("commandId");
  });

  it("rejects excess form fields without losing the entered values", () => {
    const form = createForm();
    form.set("actorDepartmentId", "browser-asserted-department");
    const parsed = parseAdmissionPeriodForm(form, createCommandId);

    expect("failure" in parsed).toBe(true);
    if (!("failure" in parsed) || parsed.failure.intent !== "create") return;
    expect(parsed.failure.commandId).toBe(createCommandId);
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
      createCommandId,
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

  it("decodes the strong item ETag separately from the merge-patch payload", () => {
    const form = new FormData();
    form.set("_intent", "revise");
    form.set("commandId", reviseCommandId);
    form.set("admissionPeriodId", "admission-period-1");
    form.set("etag", periodEtag);
    form.set("startAt", "2031-08-15T08:00");
    form.set("endAt", "2031-08-31T12:00");

    const parsed = parseAdmissionPeriodForm(form, "unused-fallback");

    expect("value" in parsed).toBe(true);
    if (!("value" in parsed) || parsed.value._tag !== "ReviseAdmissionPeriod") return;
    expect(parsed.value).toMatchObject({
      admissionPeriodId: "admission-period-1",
      etag: periodEtag,
      commandId: reviseCommandId,
    });
    expect(parsed.value.payload).toEqual({
      startAt: "2031-08-15T08:00:00.000Z",
      endAt: "2031-08-31T12:00:00.000Z",
    });
    expect(parsed.value.payload).not.toHaveProperty("expectedRevision");
    expect(parsed.value.payload).not.toHaveProperty("commandId");
  });

  it("maps decoded RFC 9457 problems to bounded UI failures", () => {
    expect(mapAdmissionPeriodError(makeNativeProblem("authority.denied"))).toEqual({
      _tag: "AdmissionRoleDenied",
      message: "Rollen din gir ikke tilgang til opptaksperioder.",
      field: undefined,
    });
    expect(mapAdmissionPeriodError(makeNativeProblem("precondition.failed"))).toEqual({
      _tag: "StaleAdmissionPeriodRevision",
      message:
        "Opptaksperioden ble endret et annet sted. Kontroller den nyeste versjonen og prøv igjen.",
      field: undefined,
    });
  });

  it("carries the canonical item ETag into the deterministic view", () => {
    const period = Schema.decodeUnknownSync(AdmissionPeriodManagementItem)(
      {
        id: "admission-period-1",
        departmentId: "department-trondheim",
        semesterId: "semester-autumn-2031",
        startAt: "2031-08-15T08:00:00.000Z",
        endAt: "2031-10-01T20:00:00.000Z",
        revision: 0,
        etag: periodEtag,
      },
      { onExcessProperty: "error" },
    );
    const view = mapAdmissionPeriodView(period);

    expect(view).toMatchObject({
      id: "admission-period-1",
      startAt: "2031-08-15T08:00:00.000Z",
      startAtInput: "2031-08-15T08:00",
      endAt: "2031-10-01T20:00:00.000Z",
      endAtInput: "2031-10-01T20:00",
      revision: 0,
      etag: periodEtag,
    });
  });
});
