/**
 * Contact: anonymous contact messages from the homepage server.
 *
 * @since 0.3.0
 */
import {
  ContactMessage,
  ContactVisitorIp,
  CONTACT_BACKEND_HEADER,
  CONTACT_IP_HEADER,
} from "@vektorprogrammet/domain/contact";
import {
  CapabilityExpressionSchema,
  CapabilityTypeId,
  ConcealmentPolicySchema,
  CredentialMechanismSchema,
  makeAccessSpec,
} from "@vektorprogrammet/domain/authz";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { withAccessSpec } from "./access.js";
import { ContactBackendCredential } from "./credential.js";
import { problemUnion, rpcProblems } from "./problem.js";

export { ContactMessage, ContactVisitorIp, CONTACT_BACKEND_HEADER, CONTACT_IP_HEADER };

/**
 * A visitor address that is not one canonical IP answers header.malformed: the homepage server
 * sends it in the `x-vektor-contact-ip` header beside its deployment secret.
 */
export const ContactProblem = problemUnion("ContactProblem", [
  "header.malformed",
  "validation.failed",
  "rate-limit.exceeded",
  "contact.unavailable",
  "internal.error",
]);

/**
 * Sends one public contact message. It consumes one of five attempts per visitor fixed one-hour
 * window and waits for delivery transport acceptance. No message is persisted, and nothing retries
 * it; success is not proof of inbox delivery.
 */
export const SubmitContactMessage = Rpc.make("contact.submitContactMessage", {
  payload: ContactMessage,
  success: Schema.Void,
  error: rpcProblems(ContactProblem),
})
  .middleware(ContactBackendCredential)
  .pipe(
    withAccessSpec(
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
        canonicalScopeResolver: "contact.department-recipient",
        concealment: ConcealmentPolicySchema.cases.Reveal.make({}),
        decisionTime: "SnapshotRead",
      }),
    ),
  );

export class ContactRpcs extends RpcGroup.make(SubmitContactMessage) {}
