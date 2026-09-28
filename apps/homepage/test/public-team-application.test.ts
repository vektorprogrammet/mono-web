import {
  IdempotencyKey,
  makeNativeProblem,
  PublicTeamApplicationIntake,
  TeamApplicationsSubmitProblem,
} from "@vektorprogrammet/rpc";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { callHomepageNative } from "../src/lib/api.server";
import { type NativeBackend, nativeRpcProblem, stubNativeBackend } from "./native-rpc";
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

    const result = failedPublicTeamApplication(completeSubmission(), makeNativeProblem(code));

    // A code without an outcome falls through to the unexpected failure.
    if (result.outcome === "rejected") expect(result.failure.error._tag).toBe(code);
  }
});

describe("team application submission failures over RPC", () => {
  // The RPC client keeps the first fetch it reads, so one stub answers every test of this file.
  let native: ReturnType<typeof stubNativeBackend>;

  beforeAll(() => {
    vi.stubEnv("API_URL", "http://api.test");
    native = stubNativeBackend();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function submitAgainst(backend: NativeBackend): Promise<PublicTeamApplicationActionData> {
    const submission = completeSubmission();

    native.answer(backend);

    return callHomepageNative((client) =>
      client["team-applications.submitTeamApplication"]({
        teamId: PublicTeamApplicationIntake.fields.teamId.make("team-it"),
        idempotencyKey: submission.commandId,
        request: submission.payload,
      }),
    ).then(
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

  it("sends the key and the decoded fields as the submission payload", async () => {
    await submitAgainst((call) => nativeRpcProblem(call, "internal.error"));

    expect(native.calls.at(-1)).toMatchObject({
      tag: "team-applications.submitTeamApplication",
      payload: {
        teamId: "team-it",
        idempotencyKey: submittedCommandId,
        request: { name: "Ada Applicant", motivation: "Jeg vil bidra." },
      },
    });
  });

  it("ends the form for a closed intake and for an unknown team", async () => {
    await expect(
      submitAgainst((call) => nativeRpcProblem(call, "team-application.intake-closed")),
    ).resolves.toMatchObject({ outcome: "closed" });
    await expect(
      submitAgainst((call) => nativeRpcProblem(call, "resource.not-found")),
    ).resolves.toEqual({ outcome: "not-found" });
  });

  it("issues a new key after a conflict that binds the key to another request", async () => {
    const key = rejectedKey(
      await submitAgainst((call) => nativeRpcProblem(call, "idempotency.digest-conflict")),
    );

    expect(key).not.toBe(submittedCommandId);
    expect(Schema.is(IdempotencyKey)(key)).toBe(true);
  });

  it("confirms a replay whose stored response expired, without a reference or a new form", async () => {
    await expect(
      submitAgainst((call) => nativeRpcProblem(call, "idempotency.response-expired")),
    ).resolves.toEqual({ outcome: "received", receipt: null });
  });

  it("retries the same key while the request is in flight or the service is unreachable", async () => {
    const inFlight = await submitAgainst((call) => nativeRpcProblem(call, "idempotency.in-flight"));

    expect(rejectedKey(inFlight)).toBe(submittedCommandId);

    const unreachable = await submitAgainst(() => {
      throw new TypeError("Network unavailable");
    });

    expect(rejectedKey(unreachable)).toBe(submittedCommandId);

    if (unreachable.outcome !== "rejected") throw new Error("Expected a rejection");

    expect(unreachable.failure.error._tag).toBe("Network");
    expect(unreachable.failure.error.status).toBe(503);
  });

  it("answers a rate-limited submission with 429 and keeps the draft and the key", async () => {
    const result = await submitAgainst((call) => nativeRpcProblem(call, "rate-limit.exceeded"));

    if (result.outcome !== "rejected")
      throw new Error(`Expected a rejection, got ${result.outcome}`);

    expect(result.failure.error.status).toBe(429);
    expect(result.failure.commandId).toBe(submittedCommandId);
    expect(result.failure.values).toMatchObject({ name: "Ada Applicant" });
  });
});
