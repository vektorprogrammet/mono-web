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
        Schema.check(
          Schema.makeFilter((value) => /^[a-f0-9]{64}$/u.test(value), { message: "a digest" }),
        ),
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

export class PublicApplicationEffectDeliveryError extends Schema.TaggedError<PublicApplicationEffectDeliveryError>()(
  "PublicApplicationEffectDeliveryError",
  { effectId: PublicApplicationIdSchema },
) {}

export interface PublicApplicationEffectInterpreter {
  readonly deliver: (
    request: PublicApplicationOutboxRequest,
    ordinal: number,
  ) => Effect.Effect<PublicApplicationEffectEvidence, PublicApplicationEffectDeliveryError>;
}

export interface PublicApplicationRecordingInterpreter extends PublicApplicationEffectInterpreter {
  readonly failOnce: (effectId: string) => void;
  readonly snapshot: () => ReadonlyArray<PublicApplicationEffectEvidence>;
}

const effectKindOf = (request: PublicApplicationOutboxRequest): PublicApplicationEffectKind =>
  request._tag;

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

export const makeRecordingPublicApplicationEffectInterpreter =
  (): PublicApplicationRecordingInterpreter => {
    const attempts = new Map<string, number>();
    const failedOnce = new Set<string>();
    const delivered = new Map<string, PublicApplicationEffectEvidence>();
    return {
      failOnce: (effectId) => {
        failedOnce.add(effectId);
      },
      snapshot: () => [...delivered.values()],
      deliver: (request, ordinal) =>
        Effect.gen(function* () {
          const nextAttempts = (attempts.get(request.effectId) ?? 0) + 1;
          attempts.set(request.effectId, nextAttempts);
          if (failedOnce.delete(request.effectId)) {
            return yield* new PublicApplicationEffectDeliveryError({ effectId: request.effectId });
          }
          const evidence: PublicApplicationEffectEvidence = {
            effectId: request.effectId,
            kind: effectKindOf(request),
            ordinal,
            attempts: nextAttempts,
            status: "Delivered",
          };
          delivered.set(request.effectId, evidence);
          return evidence;
        }),
    };
  };

export const recordPublicApplicationEffects = (
  requests: ReadonlyArray<PublicApplicationOutboxRequest>,
  interpreter = makeRecordingPublicApplicationEffectInterpreter(),
): Effect.Effect<
  ReadonlyArray<PublicApplicationEffectEvidence>,
  PublicApplicationEffectDeliveryError
> => Effect.forEach(requests, (request, ordinal) => interpreter.deliver(request, ordinal));

export interface PublicApplicationRecordingProof {
  readonly specId: "0039";
  readonly effectKinds: ReadonlyArray<PublicApplicationEffectKind>;
  readonly ordered: boolean;
  readonly containsPrivatePayload: false;
}

export const runPublicApplicationRecordingProof = (
  requests: ReadonlyArray<PublicApplicationOutboxRequest>,
): Effect.Effect<PublicApplicationRecordingProof, PublicApplicationEffectDeliveryError> =>
  recordPublicApplicationEffects(requests).pipe(
    Effect.map((evidence) => ({
      specId: "0039" as const,
      effectKinds: evidence.map((entry) => entry.kind),
      ordered: evidence.every((entry, index) => entry.ordinal === index),
      containsPrivatePayload: false as const,
    })),
  );
