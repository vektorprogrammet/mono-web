import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as fc from "effect/testing/FastCheck";
import {
  APPLICATION_STATUS_CODES,
  encodeApplicationStatus,
  encodeInterviewStatus,
  INTERVIEW_STATUS_CODES,
  parseApplicationStatus,
  parseInterviewStatus,
} from "../adapter/status.js";
import { ApplicationFromRaw } from "../schemas/application.js";

const propertyOptions = {
  fastCheck: { seed: 26082026, numRuns: 200 },
} as const;

it.prop(
  "application status codes round trip without information loss",
  { code: fc.constantFrom(...APPLICATION_STATUS_CODES) },
  ({ code }) => {
    expect(encodeApplicationStatus(parseApplicationStatus(code))).toBe(code);
  },
  propertyOptions,
);

it.prop(
  "interview status codes round trip without information loss",
  { code: fc.constantFrom(...INTERVIEW_STATUS_CODES) },
  ({ code }) => {
    expect(encodeInterviewStatus(parseInterviewStatus(code))).toBe(code);
  },
  propertyOptions,
);

it.prop(
  "application transport values survive decode and encode",
  { raw: Schema.toArbitrary(Schema.toEncoded(ApplicationFromRaw))(fc) },
  ({ raw }) => {
    const decoded = Schema.decodeUnknownSync(ApplicationFromRaw)(raw);
    expect(Schema.encodeSync(ApplicationFromRaw)(decoded)).toEqual(raw);
  },
  propertyOptions,
);


it.prop(
  "unknown status codes fail closed",
  {
    code: fc
      .integer({ min: -100, max: 100 })
      .filter(
        (code) =>
          !APPLICATION_STATUS_CODES.includes(code as never) &&
          !INTERVIEW_STATUS_CODES.includes(code as never),
      ),
  },
  ({ code }) => {
    expect(parseApplicationStatus(code)).toBeUndefined();
    expect(() => parseInterviewStatus(code)).toThrow(`Unknown interview status: ${code}`);
  },
  propertyOptions,
);
