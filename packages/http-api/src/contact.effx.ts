import { Capability, Concealment, Http, Operation } from "@effx/runtime";
import { ExternalNativeApi } from "./api.js";
import { nativeOperationAnnotations } from "./common.js";
import {
  ContactDepartmentRecipientResolver,
  contactAccessAnnotations,
} from "./contact-effx-adapters.js";
import {
  ContactCodes,
  ContactIpHeaders,
  ContactMessage,
  ContactSsrSecurity,
  ContactSubmitted,
  ContactSubmittedResponseHeaders,
} from "./contact.js";
import { nativeProblems } from "./endpoint-problems.js";

export const ContactGroup = Http.group({
  root: ExternalNativeApi,
  group: "contact",
  title: "Public contact",
  description: "Public visitor contact via authenticated homepage SSR ingress.",
  defaults: {
    middleware: [ContactSsrSecurity],
    metadata: { annotator: nativeOperationAnnotations },
    problems: { registry: nativeProblems },
    access: {
      annotator: contactAccessAnnotations,
      exposure: "External",
      acceptedCredentials: ["ObjectCapability"],
      principalKinds: ["CapabilityHolder"],
      concealment: Concealment.reveal,
    },
  },
});

/**
 * A command: it consumes one of five attempts per visitor and awaits delivery. Its access
 * decision stays `SnapshotRead`, as the handwritten AccessSpec states.
 */
export const SubmitContactMessage = Operation.command({
  name: "contact.submitContactMessage",
  input: ContactMessage,
  success: ContactSubmitted,
})
  .in(ContactGroup)
  .http.post("/api/contact-messages")
  .http.contract({
    headers: ContactIpHeaders,
    status: 201,
    responseHeaders: ContactSubmittedResponseHeaders,
    metadata: {
      summary: "Send public contact message",
      description:
        "Consumes one of five attempts per visitor fixed one-hour window and waits for delivery transport acceptance. No message is persisted; no automatic retry. HTTP 201 has no body and is not proof of inbox delivery.",
    },
  })
  .http.problems({
    identifier: "ContactProblem",
    codes: ContactCodes,
  })
  .http.access({
    capabilities: Capability.one("contact.submit"),
    requirements: [],
    canonicalScopeResolver: ContactDepartmentRecipientResolver,
    decisionTime: "SnapshotRead",
    snapshotDecisionForCommand: true,
  })
  .declare();
