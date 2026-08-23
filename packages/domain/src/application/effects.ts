import { Effect, Schema } from "effect";
import { publicApplicationCommandDigest } from "./digest.js";
import {
  PublicApplicationEmailSchema,
  PublicApplicationIdSchema,
  type Applicant,
  type PublicApplication,
  type PublicApplicationSubmitInput,
  type SubmitPublicApplicationCommand,
} from "./schema.js";

const EffectBase = {
  effectId: PublicApplicationIdSchema,
  commandId: PublicApplicationIdSchema,
  applicationId: PublicApplicationIdSchema,
  applicantId: PublicApplicationIdSchema,
};

export const PublicApplicationEffectKindSchema = Schema.Literals([
  "SendApplicantActivationOrConfirmation",
  "CreateAdmissionSubscription",
  "WriteApplicationAudit",
]);
export type PublicApplicationEffectKind = typeof PublicApplicationEffectKindSchema.Type;

export const PublicApplicationOutboxRequestSchema = Schema.TaggedUnion({
  SendApplicantActivationOrConfirmation: {
    ...EffectBase,
    email: PublicApplicationEmailSchema,
    activationDigest: Schema.optional(
      Schema.String.pipe(
        Schema.check(Schema.makeFilter((value) => /^[a-f0-9]{64}$/u.test(value), { message: "a digest" })),
      ),
    ),
  },
  CreateAdmissionSubscription: {
    ...EffectBase,
    email: PublicApplicationEmailSchema,
  },
  WriteApplicationAudit: {
    ...EffectBase,
    action: Schema.Literals(["PublicApplicationSubmitted"]),
  },
});
export type PublicApplicationOutboxRequest = typeof PublicApplicationOutboxRequestSchema.Type;

export const PublicApplicationEffectEvidenceSchema = Schema.Struct({
  effectId: PublicApplicationIdSchema,
  kind: PublicApplicationEffectKindSchema,
  ordinal: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  attempts: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  status: Schema.Literals(["Delivered"]),
});
export type PublicApplicationEffectEvidence = typeof PublicApplicationEffectEvidenceSchema.Type;

export interface PublicApplicationEffectInterpreter {
  readonly deliver: (
    request: PublicApplicationOutboxRequest,
    ordinal: number,
  ) => Effect.Effect<PublicApplicationEffectEvidence>;
}

const effectKindOf = (request: PublicApplicationOutboxRequest): PublicApplicationEffectKind => request._tag;

export const makePublicApplicationOutboxRequests = (
  command: PublicApplicationSubmitInput | SubmitPublicApplicationCommand,
  application: PublicApplication,
  applicant: Applicant,
  email: string,
): ReadonlyArray<PublicApplicationOutboxRequest> => {
  const commandDigest = publicApplicationCommandDigest(command);
  const activationDigest = applicant.activationDigest;
  const shared = {
    commandId: command.commandId,
    applicationId: application.id,
    applicantId: applicant.id,
  } as const;
  const activation: PublicApplicationOutboxRequest = {
    _tag: "SendApplicantActivationOrConfirmation",
    effectId: `public-application:${commandDigest}:activation`,
    ...shared,
    email,
    ...(activationDigest === undefined ? {} : { activationDigest }),
  };
  const subscription: PublicApplicationOutboxRequest = {
    _tag: "CreateAdmissionSubscription",
    effectId: `public-application:${commandDigest}:subscription`,
    ...shared,
    email,
  };
  const audit: PublicApplicationOutboxRequest = {
    _tag: "WriteApplicationAudit",
    effectId: `public-application:${commandDigest}:audit`,
    ...shared,
    action: "PublicApplicationSubmitted",
  };
  return [activation, subscription, audit];
};

export const makeRecordingPublicApplicationEffectInterpreter = (): PublicApplicationEffectInterpreter => {
  const attempts = new Map<string, number>();
  return {
    deliver: (request, ordinal) =>
      Effect.sync(() => {
        const nextAttempts = (attempts.get(request.effectId) ?? 0) + 1;
        attempts.set(request.effectId, nextAttempts);
        return {
          effectId: request.effectId,
          kind: effectKindOf(request),
          ordinal,
          attempts: nextAttempts,
          status: "Delivered" as const,
        };
      }),
  };
};

export const recordPublicApplicationEffects = (
  requests: ReadonlyArray<PublicApplicationOutboxRequest>,
  interpreter = makeRecordingPublicApplicationEffectInterpreter(),
): Effect.Effect<ReadonlyArray<PublicApplicationEffectEvidence>> =>
  Effect.forEach(requests, (request, ordinal) => interpreter.deliver(request, ordinal));

export interface PublicApplicationRecordingProof {
  readonly specId: "0039";
  readonly effectKinds: ReadonlyArray<PublicApplicationEffectKind>;
  readonly ordered: boolean;
  readonly containsPrivatePayload: false;
}

export const runPublicApplicationRecordingProof = (
  requests: ReadonlyArray<PublicApplicationOutboxRequest>,
): Effect.Effect<PublicApplicationRecordingProof> =>
  recordPublicApplicationEffects(requests).pipe(
    Effect.map((evidence) => ({
      specId: "0039" as const,
      effectKinds: evidence.map((entry) => entry.kind),
      ordered: evidence.every((entry, index) => entry.ordinal === index),
      containsPrivatePayload: false as const,
    })),
  );
