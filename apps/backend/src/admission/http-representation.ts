/** Admission HTTP representations: JSON reads, conditional collections, and public cache lifetimes. */
import type { Schema } from "effect";
import { conditionalJson } from "../http-api/problem.js";
import { deriveStrongETag, type ETagVersionSource } from "../http-semantics.js";

/**
 * One JSON representation that no cache stores.
 *
 * @construct http-transport
 */
export const jsonResponse = (body: Schema.Json): Response =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

/**
 * Answers a conditional read of one admission collection, tagged by the
 * versions of its items.
 *
 * @construct http-transport
 */
export const conditionalCollection = (input: {
  readonly request: Request;
  readonly body: unknown;
  readonly representationKind: string;
  readonly version: ETagVersionSource;
  readonly cacheControl: string;
}) =>
  conditionalJson({
    request: input.request,
    body: input.body,
    etag: deriveStrongETag({
      representationKind: input.representationKind,
      resourceIdentity: "collection",
      version: input.version,
    }),
    cacheControl: input.cacheControl,
    contentType: "application/json; charset=utf-8",
  });

export const dynamicAdmissionCache = (now: string, boundaries: ReadonlyArray<string>): string => {
  const nowMillis = Date.parse(now);

  const next = boundaries
    .values()
    .map(Date.parse)
    .filter((boundary) => Number.isFinite(boundary) && boundary >= nowMillis)
    .toArray()
    .sort((left, right) => left - right)[0];

  const ttl =
    next === undefined ? 30 : Math.max(0, Math.min(30, Math.floor((next - nowMillis) / 1_000)));

  return `public, max-age=${ttl}, s-maxage=${ttl}, must-revalidate`;
};
