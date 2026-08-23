import { describe, expect, it } from "vitest";
import {
  mapPublicApplicationError,
  parsePublicApplicationForm,
} from "../src/lib/public-application";

const privateCanaries = [
  "Applicant Canary",
  "Private Surname",
  "applicant-canary@example.invalid",
  "+47 900 00 039",
] as const;

function completeForm(): FormData {
  const form = new FormData();
  form.set("commandId", "command-public-application-0039");
  form.set("departmentId", "department-north");
  form.set("firstName", privateCanaries[0]);
  form.set("lastName", privateCanaries[1]);
  form.set("phone", privateCanaries[3]);
  form.set("email", privateCanaries[2]);
  form.set("gender", "0");
  form.set("fieldOfStudyId", "field-mathematics");
  form.set("yearOfStudy", "3");
  return form;
}

describe("public application form boundary", () => {
  it("produces the exact complete SDK payload with numeric legacy fields", () => {
    const parsed = parsePublicApplicationForm(completeForm());

    expect(parsed).toEqual({
      ok: true,
      value: {
        commandId: "command-public-application-0039",
        departmentId: "department-north",
        firstName: privateCanaries[0],
        lastName: privateCanaries[1],
        phone: privateCanaries[3],
        email: privateCanaries[2],
        gender: 0,
        fieldOfStudyId: "field-mathematics",
        yearOfStudy: 3,
      },
    });
    if (parsed.ok) {
      expect(Object.keys(parsed.value).sort()).toEqual(
        [
          "commandId",
          "departmentId",
          "firstName",
          "lastName",
          "phone",
          "email",
          "gender",
          "fieldOfStudyId",
          "yearOfStudy",
        ].sort(),
      );
    }
  });

  it("rejects excess and duplicate form members before the SDK call", () => {
    const excess = completeForm();
    excess.set("applicantId", "browser-owned-identity");
    const duplicate = completeForm();
    duplicate.append("departmentId", "department-foreign");

    expect(parsePublicApplicationForm(excess)).toMatchObject({
      ok: false,
      error: { _tag: "ApplicationFormInvalid" },
    });
    expect(parsePublicApplicationForm(duplicate)).toMatchObject({
      ok: false,
      error: { _tag: "ApplicationFormInvalid" },
    });
  });

  it("retains the opaque browser command ID for a rejected draft", () => {
    const form = completeForm();
    form.set("gender", "2");

    expect(parsePublicApplicationForm(form)).toMatchObject({
      ok: false,
      commandId: "command-public-application-0039",
      error: {
        _tag: "ApplicationFormInvalid",
        resetCommandId: false,
      },
    });
  });

  it("asks the browser for a new command ID only after a command conflict", () => {
    expect(
      mapPublicApplicationError({
        _tag: "DuplicatePublicApplicationCommandConflict",
      }),
    ).toMatchObject({
      _tag: "DuplicatePublicApplicationCommandConflict",
      resetCommandId: true,
    });
    expect(
      mapPublicApplicationError({ _tag: "DuplicatePublicApplication" }),
    ).toMatchObject({
      _tag: "DuplicatePublicApplication",
      resetCommandId: undefined,
    });
  });

  it("maps every public rejection tag to PII-safe Norwegian copy", () => {
    const tags = [
      "PublicApplicationDecodeError",
      "NoEligibleAdmissionPeriod",
      "DepartmentNotFound",
      "FieldOfStudyNotFound",
      "FieldOfStudyInactive",
      "FieldOfStudyDepartmentMismatch",
      "DuplicatePublicApplication",
      "DuplicatePublicApplicationCommandConflict",
      "PublicApplicationNotFound",
      "PublicApplicationPersistenceError",
      "RequestBodyTooLarge",
      "PublicApplicationRateLimitExceeded",
    ] as const;

    for (const tag of tags) {
      const mapped = mapPublicApplicationError({
        _tag: tag,
        message: privateCanaries.join(" "),
      });
      expect(mapped._tag).toBe(tag);
      for (const canary of privateCanaries) {
        expect(JSON.stringify(mapped)).not.toContain(canary);
      }
    }
  });

  it("does not echo rejected form values or unexpected error details", () => {
    const invalid = completeForm();
    invalid.delete("departmentId");
    const parsed = parsePublicApplicationForm(invalid);
    const unexpected = mapPublicApplicationError(
      new Error(privateCanaries.join(" ")),
    );
    const publicResult = JSON.stringify({ parsed, unexpected });

    for (const canary of privateCanaries) {
      expect(publicResult).not.toContain(canary);
    }
    expect(unexpected).toEqual({
      _tag: "Unexpected",
      message: "Søknaden kunne ikke sendes. Prøv igjen senere.",
    });
  });
});
