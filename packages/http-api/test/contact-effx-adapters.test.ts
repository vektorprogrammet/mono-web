import type { HttpAccessAnnotationSpec } from "@effx/runtime";
import { CONTACT_IP_HEADER } from "@vektorprogrammet/domain/contact";
import { Context, Option, Schema } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";
import { submitContactMessage } from "../.effx/generated/contact-contract.js";
import { ExternalNativeApi } from "../src/api.js";
import { AccessSpecAnnotation, reflectAccessSpec } from "../src/access.js";
import {
  ContactDepartmentRecipientResolver,
  contactAccessAnnotations,
} from "../src/contact-effx-adapters.js";
import {
  ContactCodes,
  ContactIpHeaders,
  ContactProblem,
  ContactSubmittedResponseHeaders,
} from "../src/contact.js";

const TestCapability = Schema.TaggedStruct("One", { capability: Schema.String });

const TestNone = Schema.TaggedStruct("None", {});

const TestReveal = Schema.TaggedStruct("Reveal", {});

const TestNotFound = Schema.TaggedStruct("NotFound", {
  stages: Schema.NonEmptyArray(Schema.String),
});

const declared: HttpAccessAnnotationSpec = {
  exposure: "External",
  acceptedCredentials: ["ObjectCapability"],
  principalKinds: ["CapabilityHolder"],
  capabilities: TestCapability.make({ capability: "contact.submit" }),
  requirements: [],
  canonicalScopeResolver: ContactDepartmentRecipientResolver,
  concealment: TestReveal.make({}),
  decisionTime: "SnapshotRead",
};

describe("Contact effx contract preparation", () => {
  it("derives the one ObjectCapability CapabilityHolder access contract of the generated endpoint", () => {
    const spec = Context.get(contactAccessAnnotations(declared), AccessSpecAnnotation);

    expect(spec.exposure).toBe("External");
    expect(spec.acceptedCredentials.map((mechanism) => mechanism._tag)).toEqual(["ObjectCapability"]);
    expect(spec.principalKinds).toEqual(["CapabilityHolder"]);
    expect(spec.capabilities._tag).toBe("One");
    expect(spec.capabilities).toMatchObject({ capability: { type: "contact.submit" } });
    expect(spec.requirements).toEqual([]);
    expect(spec.canonicalScopeResolver).toBe(ContactDepartmentRecipientResolver.id);
    expect(spec.concealment._tag).toBe("Reveal");
    expect(spec.decisionTime).toBe("SnapshotRead");
    expect(Option.getOrThrow(reflectAccessSpec(submitContactMessage))).toEqual(spec);
  });

  it("renders bodyless 201 and only the server-side Contact credential", () => {
    const operation = OpenApi.fromApi(ExternalNativeApi).paths["/api/contact-messages"]?.post;

    expect(operation?.operationId).toBe("contact.submitContactMessage");
    expect(operation?.security).toEqual([{ contactBackend: [] }]);
    expect(operation?.responses["401"]).toBeDefined();
    expect(Object.keys(operation?.responses["201"]?.content ?? {})).toEqual([]);
    expect(Object.keys(operation?.responses["201"]?.headers ?? {}).sort()).toEqual([
      "cache-control",
      "vary",
    ]);
  });

  it("rejects a copied resolver and any widened authority, credential or decision time", () => {
    for (const altered of [
      { ...declared, canonicalScopeResolver: { id: ContactDepartmentRecipientResolver.id } },
      { ...declared, capabilities: TestNone.make({}) },
      { ...declared, capabilities: TestCapability.make({ capability: "onboarding.claim" }) },
      { ...declared, acceptedCredentials: ["None"] as const },
      { ...declared, acceptedCredentials: ["ObjectCapability", "BetterAuthCookie"] as const },
      { ...declared, principalKinds: ["Anonymous"] as const },
      { ...declared, requirements: [{ id: "contact.open" }] },
      { ...declared, exposure: "Internal" },
      { ...declared, concealment: TestNotFound.make({ stages: ["Scope"] }) },
      { ...declared, decisionTime: "Transaction" },
      { ...declared, extra: "unexpected" },
    ] satisfies ReadonlyArray<HttpAccessAnnotationSpec>) {
      expect(() => contactAccessAnnotations(altered)).toThrow();
    }
  });

  it("derives the problem union from its one ordered eight-code tuple", () => {
    expect(ContactCodes).toEqual([
      "request.malformed",
      "header.malformed",
      "request.too-large",
      "validation.failed",
      "rate-limit.exceeded",
      "contact.unavailable",
      "media-type.unsupported",
      "internal.error",
    ]);
    expect(ContactProblem.members.map((member) => member.fields.code.literal)).toEqual(ContactCodes);
  });

  it("keeps the required canonical visitor address header and the strict no-store response headers", () => {
    expect(Object.keys(ContactIpHeaders.fields)).toEqual([CONTACT_IP_HEADER]);
    expect(Object.keys(ContactSubmittedResponseHeaders.fields)).toEqual(["cache-control", "vary"]);

    const decodeHeaders = Schema.decodeUnknownSync(ContactSubmittedResponseHeaders, {
      onExcessProperty: "error",
    });

    const headers = { "cache-control": "no-store", vary: "Origin" };

    expect(decodeHeaders(headers)).toEqual(headers);

    for (const invalid of [
      { ...headers, "cache-control": "private, no-store" },
      { ...headers, vary: "*" },
      { "cache-control": "no-store" },
      { ...headers, location: "/api/contact-messages/1" },
    ]) {
      expect(() => decodeHeaders(invalid)).toThrow();
    }

    const decodeIp = Schema.decodeUnknownSync(ContactIpHeaders, { onExcessProperty: "error" });

    expect(decodeIp({ [CONTACT_IP_HEADER]: "203.0.113.9" })).toEqual({
      [CONTACT_IP_HEADER]: "203.0.113.9",
    });

    for (const invalid of [
      {},
      { [CONTACT_IP_HEADER]: "203.0.113.9, 198.51.100.1" },
      { [CONTACT_IP_HEADER]: "203.0.113.0/24" },
      { [CONTACT_IP_HEADER]: "fe80::1%eth0" },
    ]) {
      expect(() => decodeIp(invalid)).toThrow();
    }
  });
});
