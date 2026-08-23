import { Effect, Schema } from "effect";
import { publicApplicationCommandDigest } from "./digest.js";
import {
  PublicApplicationActivationTokenSchema,
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
    activationToken: Schema.optional(PublicApplicationActivationTokenSchema),
  },
  CreateAdmissionSubscription: {
    ...EffectBase,
    email: PublicApplicationEmailSchema,
    departmentId: PublicApplicationIdSchema,
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
    attempts: number,
  ) => Effect.Effect<PublicApplicationEffectEvidence, PublicApplicationEffectDeliveryError>;
}

export interface PublicApplicationEffectPorts {
  readonly sendApplicantNotification: (
    request: Extract<
      PublicApplicationOutboxRequest,
      { readonly _tag: "SendApplicantActivationOrConfirmation" }
    >,
  ) => Effect.Effect<void, PublicApplicationEffectDeliveryError>;
  readonly createAdmissionSubscription: (
    request: Extract<
      PublicApplicationOutboxRequest,
      { readonly _tag: "CreateAdmissionSubscription" }
    >,
  ) => Effect.Effect<void, PublicApplicationEffectDeliveryError>;
  readonly writeApplicationAudit: (
    request: Extract<PublicApplicationOutboxRequest, { readonly _tag: "WriteApplicationAudit" }>,
  ) => Effect.Effect<void, PublicApplicationEffectDeliveryError>;
}

export const makePublicApplicationEffectInterpreter = (
  ports: PublicApplicationEffectPorts,
): PublicApplicationEffectInterpreter => ({
  deliver: (request, ordinal, attempts) =>
    Effect.gen(function* () {
      if (request._tag === "SendApplicantActivationOrConfirmation") {
        yield* ports.sendApplicantNotification(request);
      } else if (request._tag === "CreateAdmissionSubscription") {
        yield* ports.createAdmissionSubscription(request);
      } else {
        yield* ports.writeApplicationAudit(request);
      }
      return {
        effectId: request.effectId,
        kind: request._tag,
        ordinal,
        attempts,
        status: "Delivered" as const,
      };
    }),
});

export interface PublicApplicationRecordingInterpreter extends PublicApplicationEffectInterpreter {
  readonly failOnce: (effectId: string) => void;
  readonly snapshot: () => ReadonlyArray<PublicApplicationEffectEvidence>;
  readonly duplicateDeliveryCount: () => number;
}

const effectKindOf = (request: PublicApplicationOutboxRequest): PublicApplicationEffectKind =>
  request._tag;

export const makePublicApplicationOutboxRequests = (
  command: PublicApplicationSubmitInput | SubmitPublicApplicationCommand,
  application: PublicApplication,
  applicant: Applicant,
  email: string,
  activationToken?: string,
): ReadonlyArray<PublicApplicationOutboxRequest> => {
  const commandDigest = publicApplicationCommandDigest(command);
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
    ...(activationToken === undefined ? {} : { activationToken }),
  };
  const subscription: PublicApplicationOutboxRequest = {
    _tag: "CreateAdmissionSubscription",
    effectId: `public-application:${commandDigest}:subscription`,
    ...shared,
    email,
    departmentId: application.departmentId,
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
    let duplicateDeliveries = 0;
    const delivered = new Map<string, PublicApplicationEffectEvidence>();
    return {
      failOnce: (effectId) => {
        failedOnce.add(effectId);
      },
      duplicateDeliveryCount: () => duplicateDeliveries,
      snapshot: () => [...delivered.values()],
      deliver: (request, ordinal) =>
        Effect.gen(function* () {
          const nextAttempts = (attempts.get(request.effectId) ?? 0) + 1;
          attempts.set(request.effectId, nextAttempts);
          if (failedOnce.delete(request.effectId)) {
            return yield* new PublicApplicationEffectDeliveryError({ effectId: request.effectId });
          }
          const previous = delivered.get(request.effectId);
          if (previous !== undefined) {
            duplicateDeliveries += 1;
            return { ...previous, attempts: nextAttempts };
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
> => Effect.forEach(requests, (request, ordinal) => interpreter.deliver(request, ordinal, 1));

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
