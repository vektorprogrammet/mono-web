import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Database, type DatabaseShape } from "../database/service.js";
import { listPublicApplicationCatalog } from "./postgres.js";

const catalogDatabase = (
  fieldRevision: number,
  interval: { readonly lowerBound: string; readonly upperBound: string } = {
    lowerBound: "2031-01-01T00:00:00.000Z",
    upperBound: "2031-02-01T00:00:00.000Z",
  },
): DatabaseShape =>
  ((strings: TemplateStringsArray) => {
    const statement = strings.join("?");
    if (statement.includes("WITH boundaries")) {
      return Effect.succeed([interval]);
    }
    expect(statement).toContain("p.revision AS admission_period_revision");
    expect(statement).toContain("s.revision AS semester_revision");
    expect(statement).toContain("d.revision AS department_revision");
    expect(statement).toContain("f.revision AS field_of_study_revision");
    return Effect.succeed([
      {
        admission_period_id: "period-1",
        admission_period_revision: 7,
        semester_id: "semester-1",
        semester_revision: 11,
        department_id: "department-1",
        department_revision: 13,
        department_name: "Realfag",
        closes_at: "2031-02-01T00:00:00.000Z",
        field_of_study_id: "field-1",
        field_of_study_revision: fieldRevision,
        field_of_study_name: "Matematikk",
      },
    ]);
  }) as unknown as DatabaseShape;

const readCatalogSource = (database: DatabaseShape) =>
  listPublicApplicationCatalog({ now: "2031-01-15T12:00:00.000Z" }).pipe(
    Effect.provideService(Database, database),
  );

it.effect("returns the authoritative catalog revisions and current time interval", () =>
  Effect.gen(function* () {
    const source = yield* readCatalogSource(catalogDatabase(17));

    expect(source.catalog).toEqual({
      departments: [
        {
          departmentId: "department-1",
          name: "Realfag",
          closesAt: "2031-02-01T00:00:00.000Z",
          fieldsOfStudy: [{ fieldOfStudyId: "field-1", name: "Matematikk" }],
        },
      ],
    });
    expect(source.validatorSource).toEqual({
      intervalIdentity: "2031-01-01T00:00:00.000Z/2031-02-01T00:00:00.000Z",
      itemRevisions: [
        ["admission-department:department-1", 13],
        ["admission-field-of-study:field-1", 17],
        ["admission-period:period-1", 7],
        ["admission-semester:semester-1", 11],
      ],
    });
  }),
);

it.effect("changes only the validator source when a reference revision changes", () =>
  Effect.gen(function* () {
    const before = yield* readCatalogSource(catalogDatabase(17));
    const unchanged = yield* readCatalogSource(catalogDatabase(17));
    const revised = yield* readCatalogSource(catalogDatabase(18));

    expect(unchanged).toEqual(before);
    expect(revised.catalog).toEqual(before.catalog);
    expect(revised.validatorSource).not.toEqual(before.validatorSource);
  }),
);
