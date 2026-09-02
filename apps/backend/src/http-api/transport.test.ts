import { describe, expect, it, vi } from "vitest";
import {
  makeContentManagementTestHttp,
  makeOrganizationTestHttp,
  makeProfileTestHttp,
} from "../test/native-http.js";

const expectProblem = async (response: Response, status: number, code: string): Promise<void> => {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body).toMatchObject({
    type: `urn:vektorprogrammet:problem:v0.2:${code}`,
    status,
    code,
  });
  expect(body).not.toHaveProperty("error");
};

const unreachable = vi.fn(() => {
  throw new Error("request schema failure reached endpoint dispatch");
});

const validIdempotencyKey = "A".repeat(22);
const validETag = '"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"';

describe("native request schema error transport", () => {
  it.each([
    ["missing If-Match", { "idempotency-key": validIdempotencyKey }, 428, "precondition.required"],
    [
      "malformed If-Match",
      { "idempotency-key": validIdempotencyKey, "if-match": `W/${validETag}` },
      400,
      "precondition.invalid",
    ],
    [
      "malformed Idempotency-Key",
      { "idempotency-key": "too-short", "if-match": validETag },
      400,
      "idempotency-key.invalid",
    ],
  ] as const)("maps %s before dispatch", async (_name, transportHeaders, status, code) => {
    unreachable.mockClear();
    const response = await makeProfileTestHttp({
      config: {} as never,
      resolveActor: unreachable as never,
      run: unreachable as never,
    }).fetch(
      new Request("http://backend.test/api/profile", {
        method: "PATCH",
        headers: {
          cookie: "better-auth.session_token=transport-test-session",
          "content-type": "application/merge-patch+json",
          origin: "http://127.0.0.1:5174",
          ...transportHeaders,
        },
        body: '{"firstName":"Ada"}',
      }),
    );

    await expectProblem(response, status, code);
    expect(unreachable).not.toHaveBeenCalled();
  });

  it("maps query decoding to request.malformed before dispatch", async () => {
    unreachable.mockClear();
    const response = await makeOrganizationTestHttp({
      config: {} as never,
      resolveActor: unreachable as never,
      resolveAuthority: unreachable as never,
      run: unreachable as never,
    }).fetch(
      new Request("http://backend.test/api/mailing-lists?type=unknown", {
        headers: { cookie: "better-auth.session_token=transport-test-session" },
      }),
    );

    await expectProblem(response, 400, "request.malformed");
    expect(unreachable).not.toHaveBeenCalled();
  });

  it("maps path-parameter decoding to request.malformed before dispatch", async () => {
    unreachable.mockClear();
    const response = await makeContentManagementTestHttp(
      unreachable as never,
      unreachable as never,
    ).fetch(
      new Request("http://backend.test/api/content/articles/not-a-number", {
        headers: { cookie: "better-auth.session_token=transport-test-session" },
      }),
    );

    await expectProblem(response, 400, "request.malformed");
    expect(unreachable).not.toHaveBeenCalled();
  });
});
