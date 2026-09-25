import {
  IdempotencyKey,
  makeNativeProblem,
  type NativeProblemCode,
  PublicTeamApplicationIntake,
  TeamApplicationsSubmitProblem,
} from "@vektorprogrammet/http-api";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHomepageApiClient } from "../src/lib/api.server";
import {
  failedPublicTeamApplication,
  parsePublicTeamApplicationForm,
  type PublicTeamApplicationActionData,
  type PublicTeamApplicationFailure,
  type PublicTeamApplicationSubmission,
} from "../src/lib/public-team-application";

const submittedCommandId = "team-application-command-0925";

function completeForm(): FormData {
  const form = new FormData();

  form.set("commandId", submittedCommandId);
  form.set("name", "  Ada Applicant  ");
  form.set("email", "ada.applicant@example.invalid");
  form.set("phone", "+47 900 00 925");
  form.set("yearOfStudy", "3. klasse");
  form.set("fieldOfStudy", "Matematiske fag");
  form.set("biography", "Første linje.\r\nAndre linje.");
  form.set("motivation", "  Jeg vil bidra.  ");

  return form;
}

function formWith(name: string, value: string): FormData {
  const form = completeForm();

  form.set(name, value);

  return form;
}

function rejectedFailure(form: FormData): PublicTeamApplicationFailure {
  const parsed = parsePublicTeamApplicationForm(form);

  if (parsed.ok) throw new Error("An invalid team application form was accepted");

  return parsed.failure;
}

function completeSubmission(): PublicTeamApplicationSubmission {
  const parsed = parsePublicTeamApplicationForm(completeForm());

  if (!parsed.ok) throw new Error("The complete team application form was rejected");

  return parsed.value;
}

describe("public team application form", () => {
  it("submits the seven trimmed fields with the chosen year text and its line breaks", () => {
    expect(parsePublicTeamApplicationForm(completeForm())).toEqual({
      ok: true,
      value: {
        commandId: submittedCommandId,
        payload: {
          name: "Ada Applicant",
          email: "ada.applicant@example.invalid",
          phone: "+47 900 00 925",
          yearOfStudy: "3. klasse",
          fieldOfStudy: "Matematiske fag",
          biography: "Første linje.\r\nAndre linje.",
          motivation: "Jeg vil bidra.",
        },
      },
    });
  });

  it("accepts a 45-character field of study and rejects 46 characters on that field", () => {
    expect(parsePublicTeamApplicationForm(formWith("fieldOfStudy", "x".repeat(45))).ok).toBe(true);

    const failure = rejectedFailure(formWith("fieldOfStudy", "x".repeat(46)));

    expect(Object.keys(failure.error.fieldErrors)).toEqual(["fieldOfStudy"]);
  });

  it("rejects an invalid e-mail address on the e-mail field", () => {
    const failure = rejectedFailure(formWith("email", "ada.applicant.example.invalid"));

    expect(Object.keys(failure.error.fieldErrors)).toEqual(["email"]);
  });

  it("rejects a year of study outside the five legacy choices", () => {
    const failure = rejectedFailure(formWith("yearOfStudy", "6. klasse"));

    expect(Object.keys(failure.error.fieldErrors)).toEqual(["yearOfStudy"]);
  });

  it("reports a blank field on that field and returns the draft with the same key", () => {
    const failure = rejectedFailure(formWith("motivation", "   "));

    expect(Object.keys(failure.error.fieldErrors)).toEqual(["motivation"]);
    expect(failure.commandId).toBe(submittedCommandId);
    expect(failure.values).toMatchObject({
      name: "Ada Applicant",
      biography: "Første linje.\r\nAndre linje.",
    });
  });

  it("rejects duplicated and unexpected form members", () => {
    const duplicated = completeForm();

    duplicated.append("name", "Other Applicant");

    expect(parsePublicTeamApplicationForm(duplicated).ok).toBe(false);
    expect(parsePublicTeamApplicationForm(formWith("teamId", "team-foreign")).ok).toBe(false);
  });

  it("replaces a missing or malformed key with a new valid key", () => {
    const missing = completeForm();

    missing.delete("commandId");

    for (const form of [missing, formWith("commandId", "too-short")]) {
      const failure = rejectedFailure(form);

      expect(Schema.is(IdempotencyKey)(failure.commandId)).toBe(true);
      expect(failure.commandId).not.toBe("too-short");
    }
  });
});

it("gives every submit problem of the contract its own outcome", () => {
  for (const member of TeamApplicationsSubmitProblem.members) {
    const code = member.fields.code.literal;

    const problem =
      code === "validation.failed"
        ? { ...makeNativeProblem(code), validation: { errors: [], truncated: false } }
        : makeNativeProblem(code);

    const result = failedPublicTeamApplication(completeSubmission(), problem);

    // A code without an outcome falls through to the unexpected failure.
    if (result.outcome === "rejected") expect(result.failure.error._tag).toBe(code);
  }
});

describe("team application submission failures through the SDK", () => {
  const problemHeaders = {
    "content-type": "application/problem+json",
    "cache-control": "no-store",
    vary: "Origin",
  };

  // Effect memoizes the first global fetch it reads, so one stub answers through this binding.
  let respond: () => Response = () => {
    throw new Error("No backend response was arranged");
  };

  function problemResponse(
    code: NativeProblemCode,
    status: number,
    headers: Readonly<Record<string, string>> = {},
  ): Response {
    return Response.json(makeNativeProblem(code, status), {
      status,
      headers: { ...problemHeaders, ...headers },
    });
  }

  async function submitAgainst(next: () => Response): Promise<PublicTeamApplicationActionData> {
    const submission = completeSubmission();

    respond = next;

    return createHomepageApiClient()
      ["team-applications"].submitTeamApplication({
        params: { teamId: PublicTeamApplicationIntake.fields.teamId.make("team-it") },
        headers: { "idempotency-key": submission.commandId },
        payload: submission.payload,
      })
      .then(
        () => {
          throw new Error("Unexpected team application success");
        },
        (cause) => failedPublicTeamApplication(submission, cause),
      );
  }

  function rejectedKey(result: PublicTeamApplicationActionData): string {
    if (result.outcome !== "rejected")
      throw new Error(`Expected a rejection, got ${result.outcome}`);

    return result.failure.commandId;
  }

  beforeEach(() => {
    const fetch: typeof globalThis.fetch = async () => respond();

    vi.stubEnv("API_URL", "http://api.test");
    vi.stubGlobal("fetch", fetch);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("ends the form for a closed intake and for an unknown team", async () => {
    await expect(
      submitAgainst(() => problemResponse("team-application.intake-closed", 409)),
    ).resolves.toMatchObject({ outcome: "closed" });
    await expect(submitAgainst(() => problemResponse("resource.not-found", 404))).resolves.toEqual({
      outcome: "not-found",
    });
  });

  it("maps validation pointers to their fields and keeps the draft and key", async () => {
    const result = await submitAgainst(() =>
      Response.json(
        {
          ...makeNativeProblem("validation.failed", 422),
          validation: {
            errors: [
              { pointer: "/fieldOfStudy", code: "invalid", message: "The value is invalid." },
              { pointer: "/email", code: "missing", message: "A required value is missing." },
            ],
            truncated: false,
          },
        },
        { status: 422, headers: problemHeaders },
      ),
    );

    if (result.outcome !== "rejected")
      throw new Error(`Expected a rejection, got ${result.outcome}`);

    expect(Object.keys(result.failure.error.fieldErrors).sort()).toEqual(["email", "fieldOfStudy"]);
    expect(result.failure.commandId).toBe(submittedCommandId);
    expect(result.failure.values).toMatchObject({ name: "Ada Applicant" });
  });

  it("issues a new key after each conflict that binds the key to another request", async () => {
    const conflicts = [
      () => problemResponse("idempotency.digest-conflict", 409),
      () => problemResponse("idempotency-key.invalid", 400),
    ];

    for (const respond of conflicts) {
      const key = rejectedKey(await submitAgainst(respond));

      expect(key).not.toBe(submittedCommandId);
      expect(Schema.is(IdempotencyKey)(key)).toBe(true);
    }
  });

  it("confirms a replay whose stored response expired, without a reference or a new form", async () => {
    await expect(
      submitAgainst(() => problemResponse("idempotency.response-expired", 409)),
    ).resolves.toEqual({ outcome: "received", receipt: null });
  });

  it("retries the same key while the request is in flight or the service is unreachable", async () => {
    const retries = [
      () => problemResponse("idempotency.in-flight", 409, { "retry-after": "1" }),
      () => {
        throw new TypeError("Network unavailable");
      },
    ];

    for (const respond of retries) {
      expect(rejectedKey(await submitAgainst(respond))).toBe(submittedCommandId);
    }
  });
});
