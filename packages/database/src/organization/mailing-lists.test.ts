import { afterAll, beforeAll, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import {
  DepartmentId,
  Organization,
  PersonId,
  SemesterId,
} from "@vektorprogrammet/domain/organization";
import { Database } from "../service.js";
import { DatabaseTest } from "../layers.js";
import { OrganizationLive } from "./postgres-layer.js";
import { ProfileLive } from "../profile/postgres-layer.js";
import { makeControlledTestRuntime } from "../../test/runtime.js";

const runtime = makeControlledTestRuntime(
  ProfileLive.pipe(Layer.provideMerge(OrganizationLive.pipe(Layer.provideMerge(DatabaseTest())))),
);

afterAll(() => runtime.dispose());

const actorPersonId = PersonId.make("mail-leader");

const departmentId = DepartmentId.make("mail-department");

const current = SemesterId.make("mail-current");

const previous = SemesterId.make("mail-previous");

const authorizationInstant = "2038-09-01T12:00:00.000Z";

const read = (type: "assistants" | "team" | "all", semesterId?: SemesterId) =>
  Organization.use((organization) =>
    organization.projectMailingLists({
      actorPersonId,
      authorizationInstant,
      departmentId,
      type,
      semesterId,
    }),
  );

beforeAll(async () => {
  await runtime.runPromise(
    Database.use((sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO organization_departments (department_id,name,short_name,email,city,independent)
      VALUES ('mail-department','Mail','MAIL','mail@example.invalid','Trondheim',true)`;
        // The department's board of an independent department: its leader reads recipients.
        yield* sql`INSERT INTO organization_teams (team_id,department_id,name,kind)
      VALUES ('mail-team','mail-department','Mail board','DepartmentBoard')`;
        yield* sql`INSERT INTO admission_period_semesters (semester_id,start_at,end_at) VALUES
      ('mail-current','2038-08-01','2039-01-01'), ('mail-previous','2038-01-01','2038-08-01')`;
        yield* sql`INSERT INTO person_profiles (person_id,first_name,last_name) VALUES
      ('mail-leader','Leader','Mail'), ('mail-history','History','Mail'),
      ('mail-placement','Placement','Mail'), ('mail-boundary','Boundary','Mail'),
      ('mail-suspended','Suspended','Mail'), ('mail-no-contact','Missing','Mail')`;
        yield* sql`INSERT INTO person_contact_profiles (person_id,email,phone) VALUES
      ('mail-leader','leader@example.invalid','12345678'),
      ('mail-history','history@example.invalid','12345678'),
      ('mail-placement','placement@example.invalid','12345678'),
      ('mail-boundary','boundary@example.invalid','12345678'),
      ('mail-suspended','suspended@example.invalid','12345678')`;
        yield* sql`INSERT INTO organization_memberships
      (membership_id,person_id,team_id,start_at,end_at,is_team_leader,is_suspended) VALUES
      ('mail-leader-appointment','mail-leader','mail-team','2038-08-01',NULL,true,false),
      ('mail-shared-appointment','mail-placement','mail-team','2038-08-01',NULL,false,false),
      ('mail-boundary-appointment','mail-boundary','mail-team','2038-01-01','2038-08-01',false,false),
      ('mail-suspended-appointment','mail-suspended','mail-team','2038-08-01',NULL,false,true),
      ('mail-missing-appointment','mail-no-contact','mail-team','2038-08-01',NULL,false,false)`;
        yield* sql`INSERT INTO schools_directory_schools
      (school_id,name,contact_person,email,phone,language,active) OVERRIDING SYSTEM VALUE VALUES
      (901,'Mail school','Contact','school@example.invalid','12345678','Norwegian',true)`;
        yield* sql`INSERT INTO schools_directory_departments (school_id,department_id) VALUES (901,'mail-department')`;
        yield* sql`INSERT INTO organization_volunteer_affiliations (person_id,department_id,status,revision)
      VALUES ('mail-placement','mail-department','Active',1), ('mail-suspended','mail-department','Active',1)`;
        yield* sql`INSERT INTO assistant_placements
      (placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision) VALUES
      (${"placement-" + "a".repeat(64)},'mail-placement','mail-department','mail-current',901,'Monday',4,'1',true,1),
      (${"placement-" + "b".repeat(64)},'mail-suspended','mail-department','mail-current',901,'Monday',4,'1',false,1)`;
        const digest = "c".repeat(64);
        yield* sql`INSERT INTO person_cohort_snapshots
      (snapshot_key,source_repository,snapshot_id,source_revision,transformation_revision,snapshot_digest,occurrence_count)
      VALUES (${digest},'mail-synthetic','mail-person','test','test',${digest},1)`;
        yield* sql`INSERT INTO person_cohort_occurrences (snapshot_key,occurrence_id,disposition,reason)
      VALUES (${digest},'mail-person','Accepted','LinkedExistingPerson')`;
        yield* sql`INSERT INTO person_cohort_imports
      (source_repository,source_user_id,person_id,mapping_action,source_digest,evidence_ref,snapshot_key,occurrence_id)
      VALUES ('mail-synthetic','mail-source-person','mail-history','LinkExistingPerson',${digest},'synthetic',${digest},'mail-person')`;
        yield* sql`INSERT INTO historical_service_snapshots
      (snapshot_key,source_repository,snapshot_id,source_revision,transformation_revision,snapshot_digest,occurrence_count)
      VALUES (${digest},'mail-synthetic','mail-service','test','test',${digest},1)`;
        yield* sql`INSERT INTO historical_service_occurrences (snapshot_key,occurrence_id,disposition,reason)
      VALUES (${digest},'mail-history','Accepted','Imported')`;
        yield* sql`INSERT INTO assistant_service_history
      (source_repository,source_history_id,source_user_id,person_id,department_id,semester_id,school_id,day,workdays,block,source_digest,evidence_ref,snapshot_key,occurrence_id)
      VALUES ('mail-synthetic','mail-history','mail-source-person','mail-history','mail-department','mail-current',901,'Monday',4,'1',${digest},'synthetic',${digest},'mail-history')`;
      }),
    ),
  );
}, 20_000);

it("reads accepted history and active placements, filters appointments by semester, and deduplicates their union", async () => {
  expect(await runtime.runPromise(read("assistants", current))).toEqual([
    {
      name: "assistants-mail-department",
      emails: ["history@example.invalid", "placement@example.invalid"],
    },
  ]);
  expect(await runtime.runPromise(read("team", current))).toEqual([
    {
      name: "team-mail-department",
      emails: ["leader@example.invalid", "placement@example.invalid"],
    },
  ]);
  expect(await runtime.runPromise(read("team", previous))).toEqual([
    { name: "team-mail-department", emails: ["boundary@example.invalid"] },
  ]);
  expect(await runtime.runPromise(read("all"))).toEqual([
    {
      name: "all-mail-department",
      emails: ["history@example.invalid", "leader@example.invalid", "placement@example.invalid"],
    },
  ]);
});

it("rejects unknown and missing or ambiguous current semesters", async () => {
  expect(
    await runtime.runPromise(Effect.flip(read("all", SemesterId.make("unknown")))),
  ).toMatchObject({
    referenceKind: "Semester",
  });

  const future = Organization.use((organization) =>
    organization.projectMailingLists({
      actorPersonId,
      departmentId,
      authorizationInstant: "2040-09-01T00:00:00.000Z",
      type: "all",
    }),
  );

  expect(await runtime.runPromise(Effect.flip(future))).toMatchObject({
    referenceKind: "CurrentSemester",
  });
  await runtime.runPromise(
    Database.use(
      (sql) => sql`INSERT INTO admission_period_semesters
    (semester_id,start_at,end_at) VALUES ('mail-ambiguous','2038-08-15','2038-10-01')`,
    ),
  );

  try {
    expect(await runtime.runPromise(Effect.flip(read("all")))).toMatchObject({
      referenceKind: "CurrentSemester",
    });
  } finally {
    await runtime.runPromise(
      Database.use(
        (sql) => sql`DELETE FROM admission_period_semesters WHERE semester_id='mail-ambiguous'`,
      ),
    );
  }
});

it("fails rather than returning partial recipients when the contact store is unavailable", async () => {
  await runtime.runPromise(
    Database.use(
      (sql) => sql`ALTER TABLE person_contact_profiles RENAME TO mailing_unavailable_contacts`,
    ),
  );

  try {
    expect(await runtime.runPromise(Effect.flip(read("all", current)))).toHaveProperty(
      "_tag",
      "ProfilePersistenceError",
    );
  } finally {
    await runtime.runPromise(
      Database.use(
        (sql) => sql`ALTER TABLE mailing_unavailable_contacts RENAME TO person_contact_profiles`,
      ),
    );
  }
});

it("rechecks current leadership rather than retaining a prior authorized scope", async () => {
  await runtime.runPromise(
    Database.use(
      (sql) => sql`UPDATE organization_memberships
    SET is_team_leader=false WHERE membership_id='mail-leader-appointment'`,
    ),
  );

  try {
    expect(await runtime.runPromise(Effect.flip(read("all", current)))).toHaveProperty(
      "_tag",
      "OrganizationRoleDenied",
    );
  } finally {
    await runtime.runPromise(
      Database.use(
        (sql) => sql`UPDATE organization_memberships
      SET is_team_leader=true WHERE membership_id='mail-leader-appointment'`,
      ),
    );
  }
});
