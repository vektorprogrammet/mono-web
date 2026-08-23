/**
 * Transport layer tests.
 * Mocks globalThis.fetch to exercise HTTP mapping, auth injection, and error mapping.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect, Schema } from "effect";
import { createTransport } from "../transport.js";
import { createAdminInterviewsDomain } from "../domains/admin/interviews.js";

// Helper: run an Effect to a Promise, mapping InternalSdkError to public SdkError
function run<A>(effect: Effect.Effect<A, any>): Promise<A> {
  return Effect.runPromise(effect);
}

function runFail<E>(effect: Effect.Effect<any, E>): Promise<E> {
  return Effect.runPromise(effect.pipe(Effect.flip));
}

function makeFetchResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const SimpleSchema = Schema.Struct({ name: Schema.String });

describe("createTransport", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("successful GET", () => {
    it("returns decoded data when response is 200", async () => {
      mockFetch.mockResolvedValueOnce(makeFetchResponse(200, { name: "Alice" }));
      const transport = createTransport("http://api.test");
      const result = await run(transport.get("/test", SimpleSchema));
      expect(result).toEqual({ name: "Alice" });
    });

    it("rejects an oversized chunked JSON response before decoding", async () => {
      mockFetch.mockResolvedValueOnce(new Response(" ".repeat(1_048_577), { status: 200 }));
      const transport = createTransport("http://api.test");
      const error = await runFail(transport.get("/test", SimpleSchema));
      expect(error._tag).toBe("Network");
    });
  });

  describe("error mapping", () => {
    it("throws error with _tag Unauthorized on 401 response", async () => {
      mockFetch.mockResolvedValueOnce(makeFetchResponse(401, {}));
      const transport = createTransport("http://api.test");
      const error = await runFail(transport.get("/test", SimpleSchema));
      expect(error._tag).toBe("Unauthorized");
    });

    it("throws error with _tag NotFound on 404 response", async () => {
      mockFetch.mockResolvedValueOnce(makeFetchResponse(404, {}));
      const transport = createTransport("http://api.test");
      const error = await runFail(transport.get("/test", SimpleSchema));
      expect(error._tag).toBe("NotFound");
    });

    it("throws error with _tag Validation on 422 response", async () => {
      const body = {
        violations: [{ propertyPath: "email", message: "Invalid email" }],
      };
      mockFetch.mockResolvedValueOnce(makeFetchResponse(422, body));
      const transport = createTransport("http://api.test");
      const error = await runFail(transport.get("/test", SimpleSchema));
      expect(error._tag).toBe("Validation");
      expect(error.fields).toEqual({ email: "Invalid email" });
    });

    it("throws error with _tag Network on fetch rejection", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      const transport = createTransport("http://api.test");
      const error = await runFail(transport.get("/test", SimpleSchema));
      expect(error._tag).toBe("Network");
    });
  });

  describe("auth", () => {
    it("sends static string auth as Bearer header", async () => {
      mockFetch.mockResolvedValueOnce(makeFetchResponse(200, { name: "Bob" }));
      const transport = createTransport("http://api.test", "my-token");
      await run(transport.get("/test", SimpleSchema));
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer my-token");
    });

    it("calls auth function before each request and uses returned token", async () => {
      const authFn = vi.fn().mockResolvedValue("dynamic-token");
      mockFetch.mockResolvedValue(makeFetchResponse(200, { name: "Bob" }));
      const transport = createTransport("http://api.test", authFn);

      await run(transport.get("/test", SimpleSchema));
      await run(transport.get("/test", SimpleSchema));

      expect(authFn).toHaveBeenCalledTimes(2);
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe(
        "Bearer dynamic-token",
      );
    });
  });
  describe("interview scheduling", () => {
    it("posts the canonical schedule path and complete event payload", async () => {
      const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse(204, null));
      vi.stubGlobal("fetch", fetchMock);
      const input = {
        datetime: "2026-09-14T15:00:00+02:00",
        room: "Rom 2",
        campus: "Gløshaugen",
        mapLink: "https://maps.example.com/interview",
        from: "interviewer@example.com",
        to: "applicant@example.com",
        message: "Vi ser frem til møtet.",
      };

      await run(
        createAdminInterviewsDomain(createTransport("http://api.test")).schedule(42, input),
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://api.test/api/admin/interviews/42/schedule");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual(input);
    });

    it("rejects an invalid datetime before making a request", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const error = await runFail(
        createAdminInterviewsDomain(createTransport("http://api.test")).schedule(42, {
          datetime: "not-a-date",
          room: "Rom 2",
          campus: "Gløshaugen",
          mapLink: "https://maps.example.com/interview",
          from: "interviewer@example.com",
          to: "applicant@example.com",
          message: "Vi ser frem til møtet.",
        }),
      );

      expect(error._tag).toBe("Validation");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fresh-reads the stored interview from the real list resource", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        makeFetchResponse(200, {
          interviews: [
            {
              id: 42,
              applicantName: "Ada Lovelace",
              interviewerName: "Grace Hopper",
              scheduled: "2026-09-14T15:00:00+02:00",
              status: "Ingen svar",
              interviewed: false,
              coInterviewer: null,
              room: "Rom 2",
              campus: "Gløshaugen",
              mapLink: "https://maps.example.com/interview",
            },
          ],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const interview = await run(
        createAdminInterviewsDomain(createTransport("http://api.test")).read(42),
      );

      expect(interview.interviewTime).toBe("2026-09-14T15:00:00+02:00");
      expect(interview.room).toBe("Rom 2");
      expect(interview.campus).toBe("Gløshaugen");
      expect(interview.schedulingStatus).toBe("pending");
    });
  });
});
