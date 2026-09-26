import { Database } from "@vektorprogrammet/database";
import { ReturningAssistantsLive } from "@vektorprogrammet/database/application";
import {
  ReturningAssistantRegistrationInputSchema,
  ReturningAssistants,
} from "@vektorprogrammet/domain/application";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { backendDatabase } from "../../test/database.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

const departmentId = "returning-department";

const personId = PersonId.make("returning-person");

const now = "2031-08-15T12:00:00.000Z";

/**
 * Rita applied in the spring period, claimed her account, and served in the spring semester.
 * The autumn period is open at `now`, and her department has two teams.
 */
const database = backendDatabase(
  Database.use((sql) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO person_profiles(person_id,first_name,last_name) VALUES(${personId},'Rita','Tilbake'),('returning-coordinator','Kari','Koordinator')`;
      yield* sql`INSERT INTO organization_departments(department_id,name,short_name,email,city) VALUES(${departmentId},'Trondheim','TRD','returning@example.invalid','Trondheim')`;
      yield* sql`INSERT INTO organization_teams(team_id,department_id,name) VALUES('returning-team-a',${departmentId},'Skolekoordinering'),('returning-team-b',${departmentId},'Evaluering')`;
      yield* sql`INSERT INTO admission_period_departments(department_id,name) VALUES(${departmentId},'Trondheim')`;
      yield* sql`INSERT INTO admission_period_semesters VALUES('returning-spring','2031-01-01T00:00:00Z','2031-06-30T00:00:00Z'),('returning-autumn','2031-08-01T00:00:00Z','2031-12-31T00:00:00Z')`;
      yield* sql`INSERT INTO admission_periods VALUES('returning-spring-period',${departmentId},'returning-spring','2031-01-01T00:00:00Z','2031-02-01T00:00:00Z',0,'returning-seed'),('returning-autumn-period',${departmentId},'returning-autumn','2031-08-01T00:00:00Z','2031-09-01T00:00:00Z',0,'returning-seed')`;
      yield* sql`INSERT INTO admission_period_fields_of_study VALUES('returning-field',${departmentId},'Matematikk',true)`;
      yield* sql`INSERT INTO admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study) VALUES('returning-applicant','rita@example.invalid','rita@example.invalid','Rita','Tilbake','12345678',0,'returning-field',2)`;
      yield* sql`INSERT INTO admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at) VALUES('returning-spring-application','returning-applicant','returning-spring-period',${departmentId},'returning-field',2,'2031-01-10T00:00:00Z')`;
      yield* sql`INSERT INTO applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES('returning-invitation','returning-spring-application','returning-applicant',${digest("returning-token")},'2031-03-01T00:00:00Z','Claimed','returning-coordinator','2031-01-20T00:00:00Z')`;
      yield* sql`INSERT INTO applicant_account_links(applicant_id,person_id,linked_at,invitation_id) VALUES('returning-applicant',${personId},'2031-01-21T00:00:00Z','returning-invitation')`;
      yield* sql`INSERT INTO organization_volunteer_affiliations(person_id,department_id,status,revision) VALUES(${personId},${departmentId},'Active',1)`;

      const [school] = yield* sql<{
        readonly schoolId: number;
      }>`INSERT INTO schools_directory_schools(name,contact_person,email,phone,language,active) VALUES('Alpha skole','Kontakt','alpha@example.invalid','12345678','Norwegian',true) RETURNING school_id::double precision AS "schoolId"`;

      yield* sql`INSERT INTO schools_directory_departments(school_id,department_id) VALUES(${school!.schoolId},${departmentId})`;
      yield* sql`INSERT INTO assistant_placements(placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision) VALUES(${`placement-${digest("returning-spring")}`},${personId},${departmentId},'returning-spring',${school!.schoolId},'Monday',4,'1',false,2)`;
    }),
  ),
);

const withReturningAssistants = <A, E>(effect: Effect.Effect<A, E, ReturningAssistants>) =>
  database.run(effect.pipe(Effect.provide(ReturningAssistantsLive)));

describe("returning-assistant registration on PostgreSQL", () => {
  it("stores the chosen teams as a JSON array and reads them back", async () => {
    // The teams are out of sorted order: the registration keeps the order the assistant chose.
    const teamIds = ["returning-team-b", "returning-team-a"];

    const input = Schema.decodeUnknownSync(ReturningAssistantRegistrationInputSchema)({
      commandId: "returning-registration-command",
      admissionPeriodId: "returning-autumn-period",
      expectedRevision: 0,
      yearOfStudy: 3,
      mondayUnavailable: false,
      tuesdayUnavailable: true,
      wednesdayUnavailable: false,
      thursdayUnavailable: false,
      fridayUnavailable: false,
      positionWeeks: 4,
      preferredGroup: "all",
      language: "Norsk",
      preferredSchool: null,
      teamInterest: true,
      teamIds,
    });

    const registered = await withReturningAssistants(
      ReturningAssistants.use((returning) => returning.register(input, { personId, now })),
    );

    expect([registered.replayed, registered.observation.revision]).toEqual([false, 1]);

    const stored = await database.run(
      Database.use(
        (sql) => sql<{ readonly teamIds: unknown; readonly kind: string }>`
          SELECT team_ids AS "teamIds", jsonb_typeof(team_ids) AS kind
          FROM public.admission_returning_registrations
          WHERE person_id = ${personId}
        `,
      ),
    );

    expect(stored).toEqual([{ teamIds, kind: "array" }]);

    const options = await withReturningAssistants(
      ReturningAssistants.use((returning) => returning.readOptions({ personId, now })),
    );

    expect(options.periods.map((period) => period.currentPreferences?.teamIds)).toEqual([teamIds]);
  });
});
