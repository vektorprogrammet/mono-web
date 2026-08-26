import { Schema } from "effect";

const NonEmpty = Schema.NonEmptyString;
const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

const isRfc3339Instant = (value: string): boolean => {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (match === null) return false;
  const [, year, month, day, hour, minute, second] = match;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return false;
  }
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59 &&
    calendar.getUTCFullYear() === Number(year) &&
    calendar.getUTCMonth() === Number(month) - 1 &&
    calendar.getUTCDate() === Number(day) &&
    !Number.isNaN(Date.parse(value))
  );
};

export const Rfc3339Instant = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(isRfc3339Instant, {
      message: "an RFC 3339 instant with an explicit UTC offset",
    }),
  ),
);
export type Rfc3339Instant = typeof Rfc3339Instant.Type;

export const AdmissionPeriodId = NonEmpty;
export type AdmissionPeriodId = typeof AdmissionPeriodId.Type;
export const AdmissionCommandId = NonEmpty;
export type AdmissionCommandId = typeof AdmissionCommandId.Type;
export const AdmissionRevision = Revision;
export type AdmissionRevision = typeof AdmissionRevision.Type;

const AdmissionPeriodFields = {
  id: AdmissionPeriodId,
  departmentId: NonEmpty,
  semesterId: NonEmpty,
  startAt: Rfc3339Instant,
  endAt: Rfc3339Instant,
  revision: Revision,
  lastCommandId: AdmissionCommandId,
};

export class AdmissionPeriod extends Schema.Class<AdmissionPeriod>("AdmissionPeriod")(
  AdmissionPeriodFields,
) {}

export class AdmissionPeriodProjection extends Schema.Class<AdmissionPeriodProjection>(
  "AdmissionPeriodProjection",
)({
  ...AdmissionPeriodFields,
  eligible: Schema.Boolean,
}) {}

export class AdmissionPeriodCreateInput extends Schema.Class<AdmissionPeriodCreateInput>(
  "AdmissionPeriodCreateInput",
)({
  commandId: AdmissionCommandId,
  semesterId: NonEmpty,
  startAt: Rfc3339Instant,
  endAt: Rfc3339Instant,
  departmentId: Schema.optional(NonEmpty),
}) {}

export class AdmissionPeriodReviseInput extends Schema.Class<AdmissionPeriodReviseInput>(
  "AdmissionPeriodReviseInput",
)({
  commandId: AdmissionCommandId,
  expectedRevision: Revision,
  startAt: Rfc3339Instant,
  endAt: Rfc3339Instant,
}) {}

export const AdmissionPeriodCommandObservation = Schema.TaggedUnion({
  Created: {
    commandId: AdmissionCommandId,
    period: AdmissionPeriod,
  },
  Revised: {
    commandId: AdmissionCommandId,
    period: AdmissionPeriod,
  },
  Replayed: {
    commandId: AdmissionCommandId,
    original: Schema.Union([
      Schema.Struct({
        _tag: Schema.Literals(["Created"]),
        commandId: AdmissionCommandId,
        period: AdmissionPeriod,
      }),
      Schema.Struct({
        _tag: Schema.Literals(["Revised"]),
        commandId: AdmissionCommandId,
        period: AdmissionPeriod,
      }),
    ]),
  },
  Rejected: {
    commandId: AdmissionCommandId,
    reason: NonEmpty,
  },
});
export type AdmissionPeriodCommandObservation = typeof AdmissionPeriodCommandObservation.Type;

export const AdmissionPeriodPage = Schema.Struct({
  items: Schema.Array(AdmissionPeriodProjection),
  totalItems: Schema.Int,
});
export type AdmissionPeriodPage = typeof AdmissionPeriodPage.Type;
export const AdmissionPeriodList = AdmissionPeriodPage;
export type AdmissionPeriodList = AdmissionPeriodPage;

export const AdmissionPeriodSchema = AdmissionPeriod;
export const AdmissionPeriodProjectionSchema = AdmissionPeriodProjection;
export const AdmissionPeriodCreateInputSchema = AdmissionPeriodCreateInput;
export const AdmissionPeriodReviseInputSchema = AdmissionPeriodReviseInput;
export const AdmissionPeriodCommandObservationSchema = AdmissionPeriodCommandObservation;
export const AdmissionPeriodPageSchema = AdmissionPeriodPage;
export const AdmissionPeriodListSchema = AdmissionPeriodList;
export const AdmissionPeriodIdSchema = AdmissionPeriodId;
export const AdmissionCommandIdSchema = AdmissionCommandId;
export const AdmissionRevisionSchema = AdmissionRevision;
export const Rfc3339InstantSchema = Rfc3339Instant;
