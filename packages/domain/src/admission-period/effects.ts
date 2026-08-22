import { Schema } from "effect";
import { admissionPeriodCommandDigest } from "./digest.js";
import { AdmissionPeriodSchema, StableIdSchema } from "./schema.js";

const AdmissionPeriodEffectBase = {
  effectId: StableIdSchema,
  commandId: StableIdSchema,
  admissionPeriodId: StableIdSchema,
  revision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  period: AdmissionPeriodSchema,
};

export const AdmissionPeriodOutboxRequestSchema = Schema.TaggedUnion({
  PublishAdmissionPeriodChanged: AdmissionPeriodEffectBase,
});
export type AdmissionPeriodOutboxRequest = typeof AdmissionPeriodOutboxRequestSchema.Type;

export const makeAdmissionPeriodOutboxRequest = (
  commandId: string,
  period: typeof AdmissionPeriodSchema.Type,
): AdmissionPeriodOutboxRequest => ({
  _tag: "PublishAdmissionPeriodChanged",
  effectId: `admission-period:${admissionPeriodCommandDigest({ commandId, periodId: period.id, revision: period.revision })}`,
  commandId,
  admissionPeriodId: period.id,
  revision: period.revision,
  period,
});
