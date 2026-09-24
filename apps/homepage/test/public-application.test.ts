import { createServer } from "node:http";
import { createPromiseClient } from "@vektorprogrammet/sdk";
import { makeNativeProblem } from "@vektorprogrammet/http-api";
import { describe, expect, it } from "vitest";
import {
  mapPublicApplicationError,
  parsePublicApplicationForm,
} from "../src/lib/public-application";
import { Predicate } from "effect";


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
  it("produces the exact payload and separate idempotency header value", () => {
    const parsed = parsePublicApplicationForm(completeForm());

    expect(parsed).toEqual({
      ok: true,
      value: {
        commandId: "command-public-application-0039",
        payload: {
          departmentId: "department-north",
          firstName: privateCanaries[0],
          lastName: privateCanaries[1],
          phone: privateCanaries[3],
          email: privateCanaries[2],
          gender: 0,
          fieldOfStudyId: "field-mathematics",
          yearOfStudy: 3,
        },
      },
    });

    if (parsed.ok) {
      expect(Object.keys(parsed.value.payload).sort()).toEqual(
        [
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
      expect(parsed.value.payload).not.toHaveProperty("commandId");
    }
  });

  it("rejects excess and duplicate form members before the SDK call", () => {
    const excess = completeForm();
    excess.set("applicantId", "browser-owned-identity");
    const duplicate = completeForm();
    duplicate.append("departmentId", "department-foreign");

    const rejectedForm1 = parsePublicApplicationForm(excess);
expect(rejectedForm1.ok).toBe(false);

if (rejectedForm1.ok) throw new Error("Invalid form was accepted");
expect(rejectedForm1.error._tag).toBe("ApplicationFormInvalid");
    const rejectedForm2 = parsePublicApplicationForm(duplicate);
expect(rejectedForm2.ok).toBe(false);

if (rejectedForm2.ok) throw new Error("Invalid form was accepted");
expect(rejectedForm2.error._tag).toBe("ApplicationFormInvalid");
  });

  it("retains the opaque browser command ID for a rejected draft", () => {
    const form = completeForm();
    form.set("gender", "2");

    const rejectedForm3 = parsePublicApplicationForm(form);
expect(rejectedForm3.ok).toBe(false);

if (rejectedForm3.ok) throw new Error("Invalid form was accepted");
expect(rejectedForm3.error._tag).toBe("ApplicationFormInvalid");
expect(rejectedForm3).toMatchObject({ok: false,commandId: "command-public-application-0039"});
expect(rejectedForm3.error).toMatchObject({resetCommandId: false});
  });

  it("asks the browser for a new command ID only after an idempotency conflict", () => {
    const observedFailure1 = mapPublicApplicationError({
        code: "idempotency.digest-conflict",
      });

expect(observedFailure1._tag).toBe("idempotency.digest-conflict");
expect(observedFailure1).toMatchObject({ resetCommandId: true });
    const observedFailure2 = mapPublicApplicationError({ code: "application.duplicate" });
expect(observedFailure2._tag).toBe("application.duplicate");
    expect(
      mapPublicApplicationError({ code: "application.duplicate" }).resetCommandId,
    ).toBeUndefined();
  });

  it("maps every application problem code to PII-safe Norwegian copy", () => {
    const codes = [
      "validation.failed",
      "request.malformed",
      "media-type.unsupported",
      "application.no-eligible-period",
      "application.ambiguous-period",
      "application.invalid-field-of-study",
      "application.duplicate",
      "idempotency-key.invalid",
      "idempotency.in-flight",
      "idempotency.digest-conflict",
      "idempotency.response-expired",
      "idempotency.unavailable",
      "rate-limit.exceeded",
      "request.too-large",
      "dependency.unavailable",
      "internal.error",
    ] as const;

    for (const code of codes) {
      const mapped = mapPublicApplicationError({
        code,
        detail: privateCanaries.join(" "),
      });

      expect(mapped._tag).toBe(code);

      for (const canary of privateCanaries) {
        expect(JSON.stringify(mapped)).not.toContain(canary);
      }
    }
  });

  it("maps current validation pointers to form fields", () => {
    const observedFailure3 = mapPublicApplicationError({
        code: "validation.failed",
        validation: {
          errors: [
            { pointer: "/firstName", code: "invalid", message: "The value is invalid." },
            {
              pointer: "/fieldOfStudyId",
              code: "missing",
              message: "A required value is missing.",
            },
          ],
          truncated: false,
        },
      });

expect(observedFailure3._tag).toBe("validation.failed");
expect(observedFailure3).toMatchObject({ fieldErrors: {
        firstName: "Kontroller dette feltet.",
        fieldOfStudyId: "Kontroller dette feltet.",
      } });
  });

  it("does not echo rejected form values or unexpected error details", () => {
    const invalid = completeForm();
    invalid.delete("departmentId");
    const parsed = parsePublicApplicationForm(invalid);
    const unexpected = mapPublicApplicationError(new Error(privateCanaries.join(" ")));
    const publicResult = JSON.stringify({ parsed, unexpected });

    for (const canary of privateCanaries) {
      expect(publicResult).not.toContain(canary);
    }

    const { _tag: observedTag4, ...observedFailure4 } = unexpected;
expect(observedTag4).toBe("Unexpected");
expect(observedFailure4).toEqual({ message: "Søknaden kunne ikke sendes. Prøv igjen senere." });
  });
});


it("preserves a duplicate-application denial through the real HTTP and generated SDK boundary", async () => {
  const parsed = parsePublicApplicationForm(completeForm());

  if (!parsed.ok) throw new Error("Invalid application fixture");

  const server = createServer((_request, response) => {
    response.writeHead(409, { "Content-Type": "application/problem+json", "Cache-Control": "no-store", Vary: "Origin" });
    response.end(JSON.stringify(makeNativeProblem("application.duplicate", 409)));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();

    if (address === null || Predicate.isString(address)) throw new Error("Expected a loopback TCP listener");
    const client = createPromiseClient(`http://127.0.0.1:${address.port}`);

    const failure = await client.admissions.submitApplication({
      headers: { "idempotency-key": parsed.value.commandId }, payload: parsed.value.payload,
    }).then(() => { throw new Error("Unexpected application success"); }, mapPublicApplicationError);

    expect(failure._tag).toBe("application.duplicate");
    expect(failure.resetCommandId).toBeUndefined();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
  }
});

