import { expect, it } from "@effect/vitest";
import { StrongETag } from "@vektorprogrammet/http-api";
import { Effect } from "effect";
import { conditionalJson, jsonText, problemWebResponse } from "./problem.js";

const tag = StrongETag.make('"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"');

const previousTag = StrongETag.make('"vkr2.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"');

const cacheControl = "public, max-age=60";

const body = { title: "Ålesund", departmentIds: ["north"], active: false };

const headers200 = {
  "cache-control": cacheControl,
  "content-type": "application/json",
  etag: tag,
  vary: "Origin",
};

const headers304 = { "cache-control": cacheControl, etag: tag, vary: "Origin" };

const snapshot = (response: Response) =>
  Effect.gen(function* () {
    const bytes = yield* Effect.promise(() => response.arrayBuffer());

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      bytes: Array.from(new Uint8Array(bytes)),
    };
  });

it.effect("preserves default and pre-encoded conditional JSON bytes for 200 and 304", () =>
  Effect.gen(function* () {
    const encodedBody = yield* jsonText(body);

    const expectedBytes = Array.from(
      new TextEncoder().encode('{"title":"Ålesund","departmentIds":["north"],"active":false}'),
    );

    for (const [headers, expected] of [
      [{}, { status: 200, headers: headers200, bytes: expectedBytes }],
      [{ "if-none-match": tag }, { status: 304, headers: headers304, bytes: [] }],
    ] as const) {
      const request = new Request("http://backend.test/api/news", { headers });

      const defaultResponse = yield* conditionalJson({
        request,
        body,
        etag: tag,
        cacheControl,
        contentType: "application/json",
      });

      const suppliedResponse = yield* conditionalJson({
        request,
        encodedBody,
        etag: tag,
        cacheControl,
        contentType: "application/json",
      });

      expect(yield* snapshot(defaultResponse)).toEqual(expected);
      expect(yield* snapshot(suppliedResponse)).toEqual(expected);
    }

    // Default input still does not serialize a representation on the 304 path.
    const unchanged = yield* conditionalJson({
      request: new Request("http://backend.test/api/news", {
        headers: { "if-none-match": tag },
      }),
      body: 1n,
      etag: tag,
      cacheControl,
      contentType: "application/json",
    });

    expect(yield* snapshot(unchanged)).toEqual({ status: 304, headers: headers304, bytes: [] });
  }),
);

it.effect("preserves the same typed 412 and exact rendered problem bytes on either input", () =>
  Effect.gen(function* () {
    const encodedBody = yield* jsonText(body);

    const request = new Request("http://backend.test/api/news", {
      headers: { "if-match": previousTag },
    });

    const defaultFailure = yield* Effect.flip(
      conditionalJson({ request, body, etag: tag, cacheControl, contentType: "application/json" }),
    );

    const suppliedFailure = yield* Effect.flip(
      conditionalJson({
        request,
        encodedBody,
        etag: tag,
        cacheControl,
        contentType: "application/json",
      }),
    );

    const expected = {
      status: 412,
      headers: { "cache-control": "no-store", "content-type": "application/problem+json" },
      bytes: Array.from(
        new TextEncoder().encode(
          '{"type":"urn:vektorprogrammet:problem:v0.2:precondition.failed","title":"Precondition failed","status":412,"detail":"The selected representation changed.","code":"precondition.failed"}',
        ),
      ),
    };

    expect([defaultFailure.code, suppliedFailure.code]).toEqual([
      "precondition.failed",
      "precondition.failed",
    ]);
    expect(yield* snapshot(problemWebResponse(defaultFailure))).toEqual(expected);
    expect(yield* snapshot(problemWebResponse(suppliedFailure))).toEqual(expected);
  }),
);
