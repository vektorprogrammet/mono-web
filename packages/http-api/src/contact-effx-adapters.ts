import type { HttpAccessAnnotationSpec } from "@effx/runtime";
import {
  CapabilityExpressionSchema,
  CapabilityTypeId,
  ConcealmentPolicySchema,
  CredentialMechanismSchema,
  makeAccessSpec,
  type SCOPE_RESOLVER_IDS,
} from "@vektorprogrammet/domain/authz";
import { Schema } from "effect";
import { accessSpecAnnotations } from "./access.js";
import { decodeDeclaredOrThrow } from "./declaration-decoding.js";

/** Explicit exported resolver symbol used by the Contact contract. */
export const ContactDepartmentRecipientResolver = {
  id: "contact.department-recipient",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

/** The one ObjectCapability access contract of the public Contact submission. */
const contactNativeAccess = () =>
  makeAccessSpec({
    exposure: "External",
    acceptedCredentials: [
      CredentialMechanismSchema.cases.ObjectCapability.make({
        capabilityType: CapabilityTypeId.make("contact.submit"),
      }),
    ],
    principalKinds: ["CapabilityHolder"],
    capabilities: CapabilityExpressionSchema.cases.One.make({
      capability: { type: CapabilityTypeId.make("contact.submit") },
    }),
    requirements: [],
    canonicalScopeResolver: ContactDepartmentRecipientResolver.id,
    concealment: ConcealmentPolicySchema.cases.Reveal.make({}),
    decisionTime: "SnapshotRead",
  });

const ContactAccess = Schema.Struct({
  exposure: Schema.Literal("External"),
  acceptedCredentials: Schema.Tuple([Schema.Literal("ObjectCapability")]),
  principalKinds: Schema.Tuple([Schema.Literal("CapabilityHolder")]),
  capabilities: Schema.TaggedStruct("One", { capability: Schema.Literal("contact.submit") }),
  requirements: Schema.Array(Schema.Never),
  canonicalScopeResolver: Schema.declare(
    (value: unknown): value is typeof ContactDepartmentRecipientResolver =>
      value === ContactDepartmentRecipientResolver,
  ),
  concealment: Schema.TaggedStruct("Reveal", {}),
  decisionTime: Schema.Literal("SnapshotRead"),
});

const decodeContactAccess = decodeDeclaredOrThrow(ContactAccess, { onExcessProperty: "error" });

/** Derives native annotations only for the one existing Contact ObjectCapability access triple. */
export const contactAccessAnnotations = (input: HttpAccessAnnotationSpec) => {
  decodeContactAccess(input);

  return accessSpecAnnotations(contactNativeAccess());
};
