import { Schema } from "effect";
import { dual } from "effect/Function";
import { admissionPeriodCommandDigest } from "./digest.js";
import {
  AdmissionPeriodCommandId,
  AdmissionPeriodEffectId,
  AdmissionPeriodId,
  AdmissionPeriodSchema,
} from "./schema.js";

const AdmissionPeriodEffectBase = {
  effectId: AdmissionPeriodEffectId,
  commandId: AdmissionPeriodCommandId,
  admissionPeriodId: AdmissionPeriodId,
  revision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  period: AdmissionPeriodSchema,
};

export const AdmissionPeriodOutboxRequestSchema = Schema.TaggedUnion({
  PublishAdmissionPeriodChanged: AdmissionPeriodEffectBase,
});

export type AdmissionPeriodOutboxRequest = typeof AdmissionPeriodOutboxRequestSchema.Type;

export const admissionPeriodOutboxRequest: {
  (
    period: typeof AdmissionPeriodSchema.Type,
  ): (commandId: AdmissionPeriodCommandId) => AdmissionPeriodOutboxRequest;
  (
    commandId: AdmissionPeriodCommandId,
    period: typeof AdmissionPeriodSchema.Type,
  ): AdmissionPeriodOutboxRequest;
} = dual(
  2,
  (
    commandId: AdmissionPeriodCommandId,
    period: typeof AdmissionPeriodSchema.Type,
  ): AdmissionPeriodOutboxRequest =>
    AdmissionPeriodOutboxRequestSchema.cases.PublishAdmissionPeriodChanged.make({
      effectId: AdmissionPeriodEffectId.make(
        `admission-period:${admissionPeriodCommandDigest({ commandId, periodId: period.id, revision: period.revision })}`,
      ),
      commandId,
      admissionPeriodId: period.id,
      revision: period.revision,
      period,
    }),
);
