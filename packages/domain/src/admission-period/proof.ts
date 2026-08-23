import { Effect } from "effect";
import { admissionPeriodCommandDigest } from "./digest.js";
import { decideAdmissionPeriod } from "./update.js";
import type { AdmissionPeriod, AdmissionPeriodActor, AdmissionPeriodCommand } from "./schema.js";

export interface AdmissionPeriodProofEvidence {
  readonly specId: "0038";
  readonly accepted: {
    readonly create: boolean;
    readonly revise: boolean;
  };
  readonly rejected: {
    readonly invalidWindow: boolean;
    readonly crossDepartment: boolean;
  };
  readonly eligibility: {
    readonly beforeClose: boolean;
    readonly afterClose: boolean;
  };
  readonly replay: {
    readonly digestStable: boolean;
  };
}

export const admissionPeriodIsEligible = (
  period: AdmissionPeriod,
  semesterStartAt: string,
  semesterEndAt: string,
  now: string,
): boolean => {
  const instant = Date.parse(now);
  return (
    Date.parse(semesterStartAt) <= instant &&
    instant < Date.parse(semesterEndAt) &&
    Date.parse(period.startAt) <= instant &&
    instant < Date.parse(period.endAt)
  );
};

const proofActor: AdmissionPeriodActor = {
  _tag: "DepartmentLeader",
  personId: "proof-leader",
  departmentId: "proof-department",
  active: true,
};

const proofSemester = {
  semesterId: "proof-semester",
  startAt: "2026-08-01T00:00:00.000Z",
  endAt: "2026-12-31T23:59:59.999Z",
} as const;

const proofCreate: AdmissionPeriodCommand = {
  _tag: "CreateAdmissionPeriod",
  commandId: "proof-create",
  semesterId: proofSemester.semesterId,
  startAt: "2026-09-01T00:00:00.000Z",
  endAt: "2026-12-01T00:00:00.000Z",
};

export const runAdmissionPeriodProof = (): AdmissionPeriodProofEvidence => {
  const created = Effect.runSync(
    decideAdmissionPeriod(undefined, proofCreate, {
      actor: proofActor,
      semester: proofSemester,
      now: "2026-09-15T12:00:00.000Z",
      admissionPeriodId: "proof-period",
    }),
  );
  const revised = Effect.runSync(
    decideAdmissionPeriod(
      created.period,
      {
        _tag: "ReviseAdmissionPeriod",
        commandId: "proof-revise",
        admissionPeriodId: created.period.id,
        expectedRevision: 0,
        startAt: "2026-09-01T00:00:00.000Z",
        endAt: "2026-09-15T00:00:00.000Z",
      },
      {
        actor: proofActor,
        semester: proofSemester,
        now: "2026-09-15T12:00:00.000Z",
      },
    ),
  );
  const invalid = Effect.runSync(
    Effect.exit(
      decideAdmissionPeriod(
        undefined,
        { ...proofCreate, commandId: "proof-invalid", endAt: proofCreate.startAt },
        {
          actor: proofActor,
          semester: proofSemester,
          now: "2026-09-15T12:00:00.000Z",
        },
      ),
    ),
  );
  const crossDepartment = Effect.runSync(
    Effect.exit(
      decideAdmissionPeriod(
        undefined,
        { ...proofCreate, commandId: "proof-cross", departmentId: "other-department" },
        {
          actor: proofActor,
          semester: proofSemester,
          now: "2026-09-15T12:00:00.000Z",
        },
      ),
    ),
  );
  return {
    specId: "0038",
    accepted: { create: true, revise: revised.period.revision === 1 },
    rejected: {
      invalidWindow: invalid._tag === "Failure",
      crossDepartment: crossDepartment._tag === "Failure",
    },
    eligibility: {
      beforeClose: admissionPeriodIsEligible(
        created.period,
        proofSemester.startAt,
        proofSemester.endAt,
        "2026-09-15T12:00:00.000Z",
      ),
      afterClose: admissionPeriodIsEligible(
        revised.period,
        proofSemester.startAt,
        proofSemester.endAt,
        "2026-09-15T12:00:00.000Z",
      ),
    },
    replay: {
      digestStable:
        admissionPeriodCommandDigest(proofCreate) ===
        admissionPeriodCommandDigest({ ...proofCreate }),
    },
  };
};
