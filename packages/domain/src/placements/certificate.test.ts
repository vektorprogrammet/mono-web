import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { DepartmentId, PersonId, SemesterId } from "../organization/schema.js";
import { SchoolId } from "../schools/schema.js";
import {
  certificateContent,
  certificateContentSha256,
  certificateSemesterStatuses,
  type SemesterService,
} from "./certificate.js";

const alfa = { schoolId: SchoolId.make(1), name: "Alfa skole" };

const service = (
  semesterId: string,
  startsOn: string,
  confirmed: number | null,
  calculated: number,
): SemesterService => ({
  semesterId: SemesterId.make(semesterId),
  startsOn,
  endsOn: `${startsOn.slice(0, 4)}-12-31`,
  confirmed:
    confirmed === null ? Option.none() : Option.some({ total: confirmed, schools: [alfa] }),
  calculated,
});

const input = (services: ReadonlyArray<SemesterService>) => ({
  personId: PersonId.make("person-assistant"),
  assistantName: "Ada Assistent",
  departmentId: DepartmentId.make("department-trondheim"),
  departmentName: "Trondheim",
  services,
});

describe("certificate content", () => {
  it("lists every confirmed semester above zero with the confirmed total, oldest first", () => {
    const content = certificateContent(
      input([
        service("semester-2026", "2026-08-01", 11, 9),
        service("semester-2025", "2025-08-01", 7, 7),
        service("semester-zero", "2024-08-01", 0, 3),
        service("semester-open", "2027-01-01", null, 5),
      ]),
    );

    expect(
      Option.map(content, ({ semesters }) =>
        semesters.map(({ semesterId, days, schools }) => [semesterId, days, schools]),
      ),
    ).toEqual(
      Option.some([
        ["semester-2025", 7, ["Alfa skole"]],
        ["semester-2026", 11, ["Alfa skole"]],
      ]),
    );
  });

  it("says which semesters stay off the certificate and why", () => {
    expect(
      certificateSemesterStatuses([
        service("semester-open", "2027-01-01", null, 5),
        service("semester-zero", "2024-08-01", 0, 3),
      ]).map(({ semesterId, status, total, calculated }) => [
        semesterId,
        status,
        total,
        calculated,
      ]),
    ).toEqual([
      ["semester-zero", "ConfirmedZero", 0, 3],
      ["semester-open", "Unconfirmed", null, 5],
    ]);
  });

  it("has no certificate without a confirmed semester above zero", () => {
    expect(
      certificateContent(
        input([
          service("semester-zero", "2024-08-01", 0, 3),
          service("semester-open", "2027-01-01", null, 5),
        ]),
      ),
    ).toEqual(Option.none());
  });

  it("hashes unchanged confirmed data to the same content hash, and a correction to another", () => {
    const hash = (confirmed: number) =>
      Option.map(
        certificateContent(input([service("semester-2026", "2026-08-01", confirmed, 9)])),
        certificateContentSha256,
      );

    expect(hash(11)).toEqual(hash(11));
    expect(hash(12)).not.toEqual(hash(11));
  });
});
