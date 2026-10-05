import { Schema } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
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
 */
const acceptedCanonicalDigest = "b30a076c336d60d682cf8e63c14dc4923ff5c125437d81c35a632cfe7a2aa95a";

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const document = (): Schema.Json => decodeJson(OpenApi.fromApi(ExternalNativeApi));

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

  return setIn(setIn(swapped, [...schemasPath, left], rightContent), [...schemasPath, right], leftContent);
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
      setIn(
        base,
        [...schemasPath, "AdmissionPeriodManagementItem", "properties", "revision"],
        { type: "string" },
      ),
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
