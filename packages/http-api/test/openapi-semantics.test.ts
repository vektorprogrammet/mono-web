/**
 * EX-0022: required public native APIs in exact stable Effect4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import { Result, Schema } from "effect";
import { OpenApi } from "effect/http-api";
import { describe, expect, it } from "vitest";
import { ExternalNativeApi } from "../src/api.js";
import { canonicalOpenApiDigest, getIn, jsonObject, mapRefs, setIn } from "./openapi-canonical.js";

/**
 * The component-name-canonical reference for the repair-first handwritten Recruitment contract
 * at mono-web `9ff6ec1b`: correction controls and window commands/results, onboarding readiness
 * and standing/retry problems, with the encoded conduct example preserved. Spec 0029 records
 * every approved wire delta before this transport-parity pin. This is not full migration
 * acceptance. Later generated contracts must preserve this complete document; only component
 * names may differ. The original spec 0027 reference remains in Git history.
 *
 * Accepted by the director on 2026-10-09 for the stable Effect 4.0.0 cutover, replacing
 * `b30a076c336d60d682cf8e63c14dc4923ff5c125437d81c35a632cfe7a2aa95a`, which held at `a41ede76`
 * with Effect 4.0.0-rc.116 and remains in Git history. The single acceptance reason is the Effect
 * stable module path in the provenance string. Classified differences:
 * - G1 accepted: `x-vektorprogrammet-provenance.generator` names `effect/http-api/OpenApi.fromApi`,
 *   where it named `effect/unstable/httpapi/OpenApi.fromApi`.
 * - G2 fixed, no digest effect: the 143 `pattern` keywords that stable Effect omits for a RegExp
 *   without the `u` flag are published again through the `u` flag of the domain RegExps (`4c7ff388`).
 * - G3 kept, no digest effect: `minLength: 12` of the onboarding claim `password` stays published
 *   through one `PASSWORD_MIN_LENGTH` and an explicit annotation (`afbbb356`).
 * - G4 cosmetic: the key insertion order of 1063 responses and of `components.schemas` differs,
 *   which the digest ignores.
 * Classified diff with installed-source evidence: `/tmp/monoweb-openapi-digest-report.md`,
 * SHA-256 `10fc5c124fe6ef74c9b40e302e094ed445c7ea34e2062e1716ca4f7072c69ff2`.
 */
const acceptedCanonicalDigest = "0bd490c2ff7e01738421181d76f066a8f4da7c73c63c4c8c60179b70592ee559";

const decodeJson = Schema.decodeUnknownResult(Schema.Json);

const document = (): Schema.Json =>
  Result.getOrThrow(decodeJson(OpenApi.fromApi(ExternalNativeApi)));

const schemasPath = ["components", "schemas"] as const;

/** The path of the operation object that carries `operationId`. */
const operationPath = (spec: Schema.Json, operationId: string): ReadonlyArray<string> => {
  for (const [path, item] of Object.entries(jsonObject(getIn(spec, ["paths"])) ?? {})) {
    for (const [method, operation] of Object.entries(jsonObject(item) ?? {})) {
      if (getIn(operation, ["operationId"]) === operationId) return ["paths", path, method];
    }
  }

  throw new Error(`no operation ${operationId}`);
};

/** Swaps the names of two components and every `$ref` to them. */
const swapComponents = (spec: Schema.Json, left: string, right: string): Schema.Json => {
  const swapped = mapRefs(spec, (name) => (name === left ? right : name === right ? left : name));
  const leftContent = getIn(swapped, [...schemasPath, left]);
  const rightContent = getIn(swapped, [...schemasPath, right]);

  return setIn(
    setIn(swapped, [...schemasPath, left], rightContent),
    [...schemasPath, right],
    leftContent,
  );
};

describe("generated native OpenAPI semantics", () => {
  it("keeps every operation, status, header, security rule and schema of the accepted contract", () => {
    expect(canonicalOpenApiDigest(document())).toBe(acceptedCanonicalDigest);
  });

  it("ignores which of two identical components takes the unsuffixed name", () => {
    const swapped = swapComponents(
      document(),
      "AdmissionPeriodManagementItem",
      "AdmissionPeriodManagementItem_1",
    );

    expect(swapped).not.toEqual(document());
    expect(canonicalOpenApiDigest(swapped)).toBe(acceptedCanonicalDigest);
  });

  it("fails on a changed schema field, status, response header, security rule or operation", () => {
    const base = document();
    const submit = operationPath(base, "admissions.submitApplication");
    const confirmation = operationPath(base, "admissions.readApplicationConfirmation");
    const decide = operationPath(base, "admissionOutcomes.decideOutcome");
    const open = operationPath(base, "admissions.listOpenAdmissionPeriods");

    const mutated = [
      setIn(base, [...schemasPath, "AdmissionPeriodManagementItem", "properties", "revision"], {
        type: "string",
      }),
      setIn(base, [...submit, "responses", "201"], undefined),
      setIn(base, [...confirmation, "responses", "200", "headers", "cache-control"], undefined),
      setIn(base, [...decide, "security"], []),
      setIn(base, open, undefined),
    ];

    for (const changed of mutated) {
      expect(canonicalOpenApiDigest(changed)).not.toBe(acceptedCanonicalDigest);
    }
  });
});
