import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/shared-kernel";
import { Array as Arr, Predicate, type Schema } from "effect";

const refPrefix = "#/components/schemas/";

const digest = (value: Schema.Json): string => sha256Hex(canonicalJsonBytes(value));

/** The members of a JSON object, or nothing for any other JSON value. */
export const jsonObject = (value: Schema.Json | undefined): Schema.JsonObject | undefined => {
  if (
    value === undefined ||
    value === null ||
    Predicate.isBoolean(value) ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Arr.isArray<Schema.Json>(value)
  )
    return undefined;

  return value;
};

/** Rewrites every component `$ref` of a document through `rename`; unresolved names stay as they are. */
export const mapRefs = (
  value: Schema.Json,
  rename: (name: string) => string | undefined,
): Schema.Json => {
  const object = jsonObject(value);

  if (object === undefined) {
    return Arr.isArray<Schema.Json>(value) ? value.map((child) => mapRefs(child, rename)) : value;
  }

  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => {
      if (key === "$ref" && Predicate.isString(child) && child.startsWith(refPrefix)) {
        const name = child.slice(refPrefix.length);

        return [key, `${refPrefix}${rename(name) ?? name}`];
      }

      return [key, mapRefs(child, rename)];
    }),
  );
};

/** The value at `path` of a JSON document, when every step is an object member. */
export const getIn = (
  value: Schema.Json | undefined,
  path: ReadonlyArray<string>,
): Schema.Json | undefined => {
  const [head, ...rest] = path;

  if (head === undefined) return value;

  return getIn(jsonObject(value)?.[head], rest);
};

/** The document with `path` set to `replacement`, or removed when `replacement` is undefined. */
export const setIn = (
  value: Schema.Json,
  path: ReadonlyArray<string>,
  replacement: Schema.Json | undefined,
): Schema.Json => {
  const [head, ...rest] = path;

  if (head === undefined) return replacement ?? null;

  const object = jsonObject(value) ?? {};

  if (rest.length === 0) {
    const members = Object.entries(object).filter(([key]) => key !== head);

    return Object.fromEntries(replacement === undefined ? members : [...members, [head, replacement]]);
  }

  const child = object[head];

  const members = Object.entries(object).filter(([key]) => key !== head);

  return Object.fromEntries([...members, [head, setIn(child ?? {}, rest, replacement)]]);
};

/**
 * The SHA-256 of an OpenAPI document whose component names are derived from their content.
 *
 * @remarks
 * Effect names colliding component identifiers by encounter order, so two documents with the
 * same wire, status, header, security and schema semantics can differ in which of `X` and `X_1`
 * names which shape. This renames every `components.schemas` entry to a name derived from its
 * own content and from the content of the components it references (a refinement of content
 * hashes until the partition is stable), rewrites every `$ref`, merges entries of identical
 * content, and digests the result with canonical JSON. Any content, status, header, security or
 * operation difference changes the digest; only a component name does not.
 */
export const canonicalOpenApiDigest = (document: Schema.Json): string => {
  const components = jsonObject(getIn(document, ["components", "schemas"])) ?? {};
  const names = Object.keys(components);
  let labels: Record<string, string> = Object.fromEntries(names.map((name) => [name, ""]));
  let distinct = 1;

  for (let round = 0; round <= names.length; round++) {
    const next = Object.fromEntries(
      names.map((name) => [name, digest(mapRefs(components[name] ?? null, (ref) => labels[ref]))]),
    );

    const nextDistinct = new Set(Object.values(next)).size;

    labels = next;

    if (round > 0 && nextDistinct === distinct) break;

    distinct = nextDistinct;
  }

  const canonicalName = (name: string) => `s_${labels[name]?.slice(0, 32) ?? name}`;
  const rename = (name: string) => (name in labels ? canonicalName(name) : undefined);

  const canonicalComponents = Object.fromEntries(
    names.map((name) => [canonicalName(name), mapRefs(components[name] ?? null, rename)]),
  );

  return digest(setIn(mapRefs(document, rename), ["components", "schemas"], canonicalComponents));
};
