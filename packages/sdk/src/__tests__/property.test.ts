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
import { AdminInterviewListFromRaw } from "../schemas/interview.js";
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

const INTERVIEW_STATUS_LABELS = [
  "Ikke satt opp",
  "Ingen svar",
  "Akseptert",
  "Ny tid ønskes",
  "Kansellert",
  "Ikke oppnådd kontakt",
] as const;

it.prop(
  "interview transport values survive plain Symfony list decode and encode",
  { status: fc.constantFrom(...INTERVIEW_STATUS_LABELS) },
  ({ status }) => {
    const raw = {
      interviews: [
        {
          id: 42,
          applicantName: "Ada Lovelace",
          interviewerName: "Grace Hopper",
          scheduled: "2026-09-14T15:00:00+02:00",
          status,
          interviewed: false,
          coInterviewer: null,
          room: "Rom 2",
          campus: "Gløshaugen",
          mapLink: "https://maps.example.com/interview",
        },
      ],
    };
    const decoded = Schema.decodeUnknownSync(AdminInterviewListFromRaw)(raw);
    expect(Schema.encodeSync(AdminInterviewListFromRaw)(decoded)).toEqual(raw);
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
