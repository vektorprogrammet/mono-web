import { Predicate } from "effect";
import { RecruitmentBridgeFailure } from "./bridge";
import { describe, expect, it } from "vitest";
import { readRecruitmentBridgeOperation, RecruitmentBridgeRequestResult } from "./request.server";

const url = "https://dashboard.example/recruitment";

const validBody = JSON.stringify({
  operation: "readAssignmentBoard",
  query: { status: "new" },
});

const request = (
  body: BodyInit | null = validBody,
  headers: Record<string, string> = {},
): Request =>
  new Request(url, {
    method: "POST",
    headers: {
      origin: "https://dashboard.example",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
    body,
  });

describe("Recruitment bridge request boundary", () => {
  it("accepts one strict same-origin JSON operation", async () => {
    await expect(readRecruitmentBridgeOperation(request())).resolves.toEqual(RecruitmentBridgeRequestResult.Success({operation: {
        operation: "readAssignmentBoard",
        query: { status: "new" },
      }}));
  });

  it.each([
    ["missing", { origin: "" }],
    ["same-site cross-origin", { origin: "https://attacker.dashboard.example" }],
  ])("rejects a %s origin before dispatch", async (_label, headers) => {
    const result = await readRecruitmentBridgeOperation(request(validBody, headers));

    if (!Predicate.isTagged(result, "Failure")) throw new Error("Expected request rejection");
    expect(result.status).toBe(403);
    expect(RecruitmentBridgeFailure.guards.Forbidden(result.failure)).toBe(true);
  });

  it("rejects a CORS-safelisted text body", async () => {
    const result = await readRecruitmentBridgeOperation(
      request(validBody, { "content-type": "text/plain" }),
    );

    if (!Predicate.isTagged(result, "Failure")) throw new Error("Expected request rejection");
    expect(result.status).toBe(415);
    expect(RecruitmentBridgeFailure.guards.Validation(result.failure)).toBe(true);
  });

  it.each([
    ["declared", validBody, { "content-length": "4097" }],
    ["streamed", "x".repeat(4097), {}],
  ])("rejects a %s oversized body", async (_label, body, headers) => {
    const result = await readRecruitmentBridgeOperation(request(body, headers));

    if (!Predicate.isTagged(result, "Failure")) throw new Error("Expected request rejection");
    expect(result.status).toBe(413);
    expect(RecruitmentBridgeFailure.guards.Validation(result.failure)).toBe(true);
  });

  it.each([
    ["malformed JSON", "{"],
    ["malformed UTF-8", new Uint8Array([0xc3, 0x28])],
    [
      "an excess property",
      JSON.stringify({ operation: "readAssignmentBoard", query: { status: "new" }, extra: true }),
    ],
  ])("rejects %s without dispatch", async (_label, body) => {
    const result = await readRecruitmentBridgeOperation(request(body));

    if (!Predicate.isTagged(result, "Failure")) throw new Error("Expected request rejection");
    expect(result.status).toBe(422);
    expect(RecruitmentBridgeFailure.guards.Validation(result.failure)).toBe(true);
  });
});
