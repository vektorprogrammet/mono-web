/**
 * Falsifiers of days served and certificates on PostgreSQL (docs/specs/certificates-days-served.md):
 * what counts as a day, what a certificate lists, attributable append-only history, recorded
 * issues with stable content hashes, the issuer rules of journey 3, derived board seats, and the
 * assistant's own certificate.
 */
import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Exit, Layer, Option } from "effect";
import { ConstraintError } from "effect/unstable/sql/SqlError";
import { DelegationArea, DelegationCommand } from "@vektorprogrammet/domain/authz";
import {
  BoardRosterSeat,
  DepartmentId,
  Organization,
  PersonId,
  SemesterId,
  TeamId,
} from "@vektorprogrammet/domain/organization";
import {
  CertificateAccessDenied,
  CertificateEmpty,
  type CertificatePrincipal,
  daysServedEntryVersion,
  Placements,
  SchoolServiceCommitmentId,
  SchoolServiceOccurrenceId,
  SchoolServiceProposalId,
} from "@vektorprogrammet/domain/placements";
import { SchoolId } from "@vektorprogrammet/domain/schools";
import { Database } from "../service.js";
import { DatabaseTestLive } from "../test-support/platform.js";
import { OrganizationLive } from "../organization/postgres-layer.js";
import { mutateCoverageBoard } from "./coverage.js";
import {
  lockPlacementDepartment,
  mutateAffiliation,
  mutatePlacementBoard,
  readOwnAffiliation,
} from "./postgres.js";
import { PlacementsLive } from "./service.js";

const databaseLayer = DatabaseTestLive();

const trondheim = DepartmentId.make("cert-trondheim");

const aas = DepartmentId.make("cert-aas");

const spring = SemesterId.make("cert-spring");

const autumn = SemesterId.make("cert-autumn");

const lade = SchoolId.make(9101);

const aasSchool = SchoolId.make(9102);

const rosten = SchoolId.make(9103);

const person = {
  ada: PersonId.make("cert-ada"),
  bo: PersonId.make("cert-bo"),
  cato: PersonId.make("cert-cato"),
  coordinator: PersonId.make("cert-coordinator"),
  styretLeader: PersonId.make("cert-styret-leader"),
  styretMember: PersonId.make("cert-styret-member"),
  itLeader: PersonId.make("cert-it-leader"),
  eventLeader: PersonId.make("cert-event-leader"),
  itMember: PersonId.make("cert-it-member"),
  hsMember: PersonId.make("cert-hs-member"),
  nationalLeader: PersonId.make("cert-national-leader"),
  aasLeader: PersonId.make("cert-aas-leader"),
  administrator: PersonId.make("cert-administrator"),
};

const proposalId = SchoolServiceProposalId.make(`school-service-proposal-${"c".repeat(64)}`);

const digest = (n: number) => n.toString(16).padStart(64, "0");

let commandNumber = 0x1000;

const nextCommandId = () => digest(++commandNumber);

/** A principal resolved at the current instant, as a committing request resolves it. */
const principal = (personId: PersonId) =>
  DateTime.now.pipe(
    Effect.map(
      (now): CertificatePrincipal => ({ personId, authorizationInstant: DateTime.formatIso(now) }),
    ),
  );

/** Runs one service call in its own transaction, as the HTTP layer does. */
const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Database.use((sql) => sql.withTransaction(effect));

const confirm = (
  actor: PersonId,
  semesterId: SemesterId,
  personId: PersonId,
  total: number,
  departmentId = trondheim,
) =>
  Effect.gen(function* () {
    const reader = yield* principal(actor);

    return yield* transaction(
      Placements.use((placements) =>
        placements.confirmDaysServed(
          reader,
          { commandId: nextCommandId(), departmentId, semesterId, personId, total },
          () => Effect.void,
        ),
      ),
    );
  });

const issue = (actor: PersonId, departmentId: DepartmentId, personId: PersonId) =>
  Effect.gen(function* () {
    const reader = yield* principal(actor);

    return yield* transaction(
      Placements.use((placements) =>
        placements.issueCertificate(
          reader,
          { commandId: nextCommandId(), departmentId, personId },
          () => Effect.void,
        ),
      ),
    );
  });

const readCertificate = (actor: PersonId, departmentId: DepartmentId, personId: PersonId) =>
  Effect.gen(function* () {
    const reader = yield* principal(actor);

    return yield* Placements.use((placements) =>
      placements.readCertificate(reader, departmentId, personId),
    );
  });

const readDaysServed = (actor: PersonId, semesterId: SemesterId) =>
  Effect.gen(function* () {
    const reader = yield* principal(actor);

    return yield* Placements.use((placements) =>
      placements.readDaysServed(reader, { departmentId: trondheim, semesterId }),
    );
  });

const autumnScope = { departmentId: trondheim, semesterId: autumn };

const serviceNow = "2026-09-06T00:00:00.000Z";

/** The organization, the schools, and the legacy service of every case. */
const seedOrganization = Database.use((sql) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO person_profiles (person_id,first_name,last_name) VALUES
      (${person.ada},'Ada','Assistent'), (${person.bo},'Bo','Plassert'),
      (${person.cato},'Cato','Tidligere'), (${person.coordinator},'Kari','Koordinator'),
      (${person.styretLeader},'Siri','Styreleder'), (${person.styretMember},'Sverre','Styremedlem'),
      (${person.itLeader},'Ivar','Itleder'), (${person.eventLeader},'Eva','Arrangementsleder'),
      (${person.itMember},'Mona','Medlem'), (${person.hsMember},'Hanne','Hovedstyret'),
      (${person.nationalLeader},'Nils','Nasjonal'), (${person.aasLeader},'Åse','Lokalleder'),
      (${person.administrator},'Glen','Global')`;
    yield* sql`INSERT INTO auth."user" (id,name,email,"emailVerified")
      SELECT person_id, first_name, person_id || '@example.invalid', true
      FROM person_profiles WHERE person_id LIKE 'cert-%'`;
    yield* sql`INSERT INTO organization_departments
      (department_id,name,short_name,email,city,independent) VALUES
      (${trondheim},'Trondheim','TRD','trd@example.invalid','Trondheim',true),
      (${aas},'Ås','AAS','aas@example.invalid','Ås',false)`;
    yield* sql`INSERT INTO organization_teams (team_id,department_id,name,kind,team_scope) VALUES
      ('cert-styret',${trondheim},'Styret','DepartmentBoard','HomeDepartment'),
      ('cert-skolekoordinering',${trondheim},'Skolekoordinering','Team','HomeDepartment'),
      ('cert-it',${trondheim},'IT','Team','HomeDepartment'),
      ('cert-event',${trondheim},'Arrangement','Team','HomeDepartment'),
      ('cert-national',${trondheim},'Rekruttering nasjonalt','Team','National'),
      ('cert-aas-team',${aas},'Ås-teamet','Team','HomeDepartment')`;
    yield* sql`INSERT INTO organization_national_boards (board_id,name) VALUES ('cert-hs','Hovedstyret')`;
    yield* sql`INSERT INTO organization_memberships
      (membership_id,person_id,team_id,board_id,position_name,start_at,end_at,is_team_leader,is_suspended) VALUES
      ('cert-m-styret-leader',${person.styretLeader},'cert-styret',NULL,'Styreleder','2020-01-01',NULL,true,false),
      ('cert-m-styret-member',${person.styretMember},'cert-styret',NULL,'Nestleder','2020-01-01',NULL,false,false),
      ('cert-m-coordinator',${person.coordinator},'cert-skolekoordinering',NULL,NULL,'2020-01-01',NULL,false,false),
      ('cert-m-it-leader',${person.itLeader},'cert-it',NULL,NULL,'2020-01-01',NULL,true,false),
      ('cert-m-event-leader',${person.eventLeader},'cert-event',NULL,NULL,'2020-01-01',NULL,true,false),
      ('cert-m-it-member',${person.itMember},'cert-it',NULL,NULL,'2020-01-01',NULL,false,false),
      ('cert-m-national-leader',${person.nationalLeader},'cert-national',NULL,NULL,'2020-01-01',NULL,true,false),
      ('cert-m-aas-leader',${person.aasLeader},'cert-aas-team',NULL,NULL,'2020-01-01',NULL,true,false),
      ('cert-m-hs-member',${person.hsMember},NULL,'cert-hs','Styremedlem','2020-01-01',NULL,false,false)`;
    yield* sql`INSERT INTO organization_global_administrator_grants (grant_id,person_id,start_at,end_at,revision)
      VALUES ('cert-grant',${person.administrator},'2020-01-01',NULL,0)`;
    yield* sql`INSERT INTO admission_period_semesters (semester_id,start_at,end_at) VALUES
      (${spring},'2026-01-01T00:00:00Z','2026-08-01T00:00:00Z'),
      (${autumn},'2026-08-01T00:00:00Z','2026-12-31T00:00:00Z')`;
    yield* sql`INSERT INTO schools_directory_schools
      (school_id,name,contact_person,email,phone,language,active) OVERRIDING SYSTEM VALUE VALUES
      (${lade},'Lade skole','Kontakt','lade@example.invalid','12345678','Norwegian',true),
      (${aasSchool},'Ås skole','Kontakt','aas-skole@example.invalid','12345678','Norwegian',true),
      (${rosten},'Rosten skole','Kontakt','rosten@example.invalid','12345678','Norwegian',true)`;
    yield* sql`INSERT INTO schools_directory_departments (school_id,department_id) VALUES
      (${lade},${trondheim}), (${aasSchool},${aas}), (${rosten},${trondheim})`;

    // Accepted legacy totals: Ada and Cato served in the spring in both departments.
    const people = digest(0xa1);
    const service = digest(0xa2);
    yield* sql`INSERT INTO person_cohort_snapshots
      (snapshot_key,source_repository,snapshot_id,source_revision,transformation_revision,snapshot_digest,occurrence_count)
      VALUES (${people},'cert-synthetic','cert-people','test','test',${people},2)`;
    yield* sql`INSERT INTO person_cohort_occurrences (snapshot_key,occurrence_id,disposition,reason) VALUES
      (${people},'cert-person-ada','Accepted','LinkedExistingPerson'),
      (${people},'cert-person-cato','Accepted','LinkedExistingPerson')`;
    yield* sql`INSERT INTO person_cohort_imports
      (source_repository,source_user_id,person_id,mapping_action,source_digest,evidence_ref,snapshot_key,occurrence_id) VALUES
      ('cert-synthetic','cert-source-ada',${person.ada},'LinkExistingPerson',${people},'synthetic',${people},'cert-person-ada'),
      ('cert-synthetic','cert-source-cato',${person.cato},'LinkExistingPerson',${people},'synthetic',${people},'cert-person-cato')`;
    yield* sql`INSERT INTO historical_service_snapshots
      (snapshot_key,source_repository,snapshot_id,source_revision,transformation_revision,snapshot_digest,occurrence_count)
      VALUES (${service},'cert-synthetic','cert-service','test','test',${service},4)`;
    yield* sql`INSERT INTO historical_service_occurrences (snapshot_key,occurrence_id,disposition,reason) VALUES
      (${service},'cert-ada-trondheim','Accepted','Imported'), (${service},'cert-ada-aas','Accepted','Imported'),
      (${service},'cert-cato-trondheim','Accepted','Imported'), (${service},'cert-cato-aas','Accepted','Imported')`;
    yield* sql`INSERT INTO assistant_service_history
      (source_repository,source_history_id,source_user_id,person_id,department_id,semester_id,school_id,day,workdays,block,source_digest,evidence_ref,snapshot_key,occurrence_id) VALUES
      ('cert-synthetic','cert-ada-trondheim','cert-source-ada',${person.ada},${trondheim},${spring},${lade},'Monday',6,'1',${service},'synthetic',${service},'cert-ada-trondheim'),
      ('cert-synthetic','cert-ada-aas','cert-source-ada',${person.ada},${aas},${spring},${aasSchool},'Monday',3,'1',${service},'synthetic',${service},'cert-ada-aas'),
      ('cert-synthetic','cert-cato-trondheim','cert-source-cato',${person.cato},${trondheim},${spring},${lade},'Friday',4,'1',${service},'synthetic',${service},'cert-cato-trondheim'),
      ('cert-synthetic','cert-cato-aas','cert-source-cato',${person.cato},${aas},${spring},${aasSchool},'Friday',2,'1',${service},'synthetic',${service},'cert-cato-aas')`;
  }),
);

const commitment = (digit: string) =>
  SchoolServiceCommitmentId.make(`school-service-commitment-${digit.repeat(64)}`);

const serviceIds = (digit: string) => ({
  absenceId: "unused",
  coverageId: "unused",
  occurrenceId: SchoolServiceOccurrenceId.make(`school-service-occurrence-${digit.repeat(64)}`),
});

/**
 * Dated service in Trondheim in the autumn. Ada completes two blocks at Lade on 7 September,
 * attends an Unfulfilled service at Rosten on 8 September, and appears on a standalone occurrence
 * at Lade on 15 September. Bo holds a placement of eight workdays and attends nothing. Sverre, a
 * Styret member, is placed.
 */
const seedService = Database.use((sql) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* lockPlacementDepartment(trondheim);

      for (const [personId, placements] of [
        [
          person.ada,
          [
            [lade, "Monday", "1", "1"],
            [lade, "Monday", "2", "2"],
            [rosten, "Tuesday", "1", "3"],
          ],
        ],
        [person.bo, [[lade, "Wednesday", "1", "4"]]],
        [person.styretMember, [[lade, "Thursday", "1", "5"]]],
      ] as const) {
        const pending = yield* mutateAffiliation(
          yield* readOwnAffiliation(personId, trondheim),
          "Request",
          personId,
          serviceNow,
        );

        yield* mutateAffiliation(pending, "Establish", person.coordinator, serviceNow);

        for (const [schoolId, day, block, placementDigit] of placements)
          yield* mutatePlacementBoard(
            autumnScope,
            { action: "Create", personId, schoolId, day, workdays: 8, block },
            person.coordinator,
            serviceNow,
            `placement-${placementDigit.repeat(64)}`,
          );
      }

      const assignment = (
        schoolId: SchoolId,
        schoolName: string,
        day: string,
        block: string,
        placementDigit: string,
      ) => ({
        placementId: `placement-${placementDigit.repeat(64)}`,
        personId: person.ada,
        firstName: "Ada",
        lastName: "Assistent",
        schoolId,
        schoolName,
        day,
        block,
      });

      yield* sql`INSERT INTO school_service_proposals(proposal_id,department_id,semester_id,status,revision,created_at,created_by_person_id,confirmed_at,confirmed_by_person_id,demand_snapshot,assignment_snapshot,exception_snapshot,reviewed_exception_ids)
        VALUES(${proposalId},${trondheim},${autumn},'Confirmed',2,${serviceNow},${person.coordinator},${serviceNow},${person.coordinator},${sql.json(
          [
            { schoolId: lade, day: "Monday", block: "1", requiredVolunteers: 1, revision: 1 },
            { schoolId: lade, day: "Monday", block: "2", requiredVolunteers: 1, revision: 1 },
            { schoolId: rosten, day: "Tuesday", block: "1", requiredVolunteers: 2, revision: 1 },
          ],
        )},${sql.json([
          assignment(lade, "Lade skole", "Monday", "1", "1"),
          assignment(lade, "Lade skole", "Monday", "2", "2"),
          assignment(rosten, "Rosten skole", "Tuesday", "1", "3"),
        ])},${sql.json([])},${sql.json([])})`;

      for (const [commitmentId, schoolId, serviceDate, day, block, startTime, endTime] of [
        [commitment("1"), lade, "2026-09-07", "Monday", "1", "09:00", "11:00"],
        [commitment("2"), lade, "2026-09-07", "Monday", "2", "12:00", "14:00"],
        [commitment("3"), rosten, "2026-09-08", "Tuesday", "1", "09:00", "11:00"],
      ] as const)
        yield* mutatePlacementBoard(
          autumnScope,
          {
            action: "ScheduleService",
            proposalId,
            schoolId,
            day,
            block,
            serviceDate,
            startTime,
            endTime,
          },
          person.coordinator,
          serviceNow,
          commitmentId,
        );

      const evidenceSource = "School contact attendance register";

      for (const [commitmentId, digit] of [
        [commitment("1"), "1"],
        [commitment("2"), "2"],
      ] as const)
        yield* mutateCoverageBoard(
          autumnScope,
          { action: "CompleteService", commitmentId, evidenceSource },
          person.coordinator,
          "2026-09-08T18:00:00.000Z",
          serviceIds(digit),
        );

      // Ada attended, but one assistant was short: the outcome is Unfulfilled.
      yield* mutateCoverageBoard(
        autumnScope,
        {
          action: "MarkUnfulfilledService",
          commitmentId: commitment("3"),
          reason: "One assistant short",
          evidenceSource,
        },
        person.coordinator,
        "2026-09-08T18:00:00.000Z",
        serviceIds("3"),
      );

      // A standalone occurrence predates dated commitments; its guard admits no new one.
      yield* sql`ALTER TABLE school_service_occurrences DISABLE TRIGGER school_service_occurrence_insert_guard`;
      yield* sql`INSERT INTO school_service_occurrences
        (occurrence_id,commitment_id,proposal_id,department_id,semester_id,school_id,day,block,occurred_on,attended_person_ids,recorded_at,recorded_by_person_id)
        VALUES (${serviceIds("4").occurrenceId},NULL,${proposalId},${trondheim},${autumn},${lade},'Tuesday','1','2026-09-15',
          ${sql.json([person.ada])},'2026-09-15T18:00:00.000Z',${person.coordinator})`;
      yield* sql`ALTER TABLE school_service_occurrences ENABLE TRIGGER school_service_occurrence_insert_guard`;
    }),
  ),
);

/** The department grants the confirmation capability to Skolekoordinering by an explicit command. */
const seedDelegation = Organization.use((organization) =>
  organization.executeDelegation(
    DelegationCommand.cases.IssueDelegation.make({
      commandId: "cert-delegation-command",
      reason: "Semesterslutt",
      name: "Dager tjenestegjort",
      teamId: TeamId.make("cert-skolekoordinering"),
      capability: "placements.days-served",
      area: DelegationArea.cases.Department.make({ departmentId: trondheim }),
      holders: "AllMembers",
      startAt: "2020-06-01T00:00:00.000Z",
      endAt: null,
    }),
    person.styretLeader,
  ),
);

/** Cato's spring service is confirmed in both departments: the issuer matrix issues it. */
const seedCatoConfirmations = Effect.gen(function* () {
  yield* confirm(person.administrator, spring, person.cato, 4);
  yield* confirm(person.administrator, spring, person.cato, 2, aas);
});

const suiteLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* seedOrganization;
    yield* seedService;
    yield* seedDelegation;
    yield* seedCatoConfirmations;
  }),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      OrganizationLive.pipe(Layer.provideMerge(databaseLayer)),
      PlacementsLive.pipe(Layer.provide(databaseLayer)),
    ),
  ),
);

/** Every service fact that confirmation and issue must leave unchanged. */
const serviceFacts = Database.use((sql) =>
  Effect.gen(function* () {
    const decisions = yield* sql`SELECT * FROM school_service_decisions ORDER BY commitment_id`;
    const occurrences = yield* sql`SELECT * FROM school_service_occurrences ORDER BY occurrence_id`;
    const placements = yield* sql`SELECT * FROM assistant_placements ORDER BY placement_id`;
    const history = yield* sql`SELECT * FROM assistant_service_history ORDER BY source_history_id`;

    return { decisions, occurrences, placements, history };
  }),
);

const confirmationRows = (personId: PersonId) =>
  Database.use(
    (sql) => sql`SELECT revision, total, calculated, confirmed_by_person_id AS "confirmedBy"
      FROM days_served_confirmations
      WHERE person_id = ${personId} AND department_id = ${trondheim} AND semester_id = ${autumn}
      ORDER BY revision`,
  );

const issueRows = (personId: PersonId) =>
  Database.use(
    (sql) => sql`SELECT department_id AS "departmentId", content_sha256 AS "contentSha256",
      issued_by_person_id AS "issuedBy", issuer_name AS "issuerName", seat_title AS "seatTitle",
      issuer_basis AS basis, content_json AS content
      FROM certificate_issues WHERE person_id = ${personId} ORDER BY issued_at, issue_id`,
  );

layer(suiteLayer, { excludeTestServices: true, timeout: "60 seconds" })(
  "days served and certificates on PostgreSQL",
  (it) => {
    it.effect(
      "counts one day per date of completed dated service, and nothing for placements, Unfulfilled outcomes, or standalone occurrences",
      () =>
        Effect.gen(function* () {
          const page = yield* readDaysServed(person.coordinator, autumn);

          const entry = (personId: PersonId) =>
            page.items.find((item) => item.personId === personId);

          expect(page.items.map((item) => item.personId)).toEqual([
            person.ada,
            person.bo,
            person.styretMember,
          ]);
          // Two completed blocks on one date count once; 8 and 15 September do not count.
          expect(entry(person.ada)).toMatchObject({
            calculated: 1,
            revision: 0,
            confirmation: null,
            evidence: {
              dates: [
                { serviceDate: "2026-09-07", schools: [{ schoolId: lade, name: "Lade skole" }] },
              ],
              legacyTotals: [],
            },
          });
          // A placement of eight workdays without recorded attendance adds no day.
          expect(entry(person.bo)).toMatchObject({ calculated: 0, evidence: { dates: [] } });

          const legacy = yield* readDaysServed(person.coordinator, spring);

          // An accepted legacy total counts as a total of the department, never as dates.
          expect(legacy.items).toMatchObject([
            {
              personId: person.ada,
              calculated: 6,
              evidence: {
                dates: [],
                legacyTotals: [{ workdays: 6, school: { name: "Lade skole" } }],
              },
            },
            { personId: person.cato, calculated: 4 },
          ]);
        }),
    );

    it.effect(
      "appends an attributable correction, keeps the earlier confirmation, and changes no service fact",
      () =>
        Effect.gen(function* () {
          const before = yield* serviceFacts;

          const [initial] = (yield* readDaysServed(person.coordinator, autumn)).items.filter(
            (item) => item.personId === person.bo,
          );

          const first = yield* confirm(person.coordinator, autumn, person.bo, 0);
          const corrected = yield* confirm(person.coordinator, autumn, person.bo, 3);

          expect(first.confirmation).toMatchObject({
            revision: 1,
            total: 0,
            calculated: 0,
            confirmedBy: person.coordinator,
            confirmedByName: "Kari Koordinator",
          });
          expect(corrected).toMatchObject({ revision: 2, confirmation: { revision: 2, total: 3 } });
          expect(yield* confirmationRows(person.bo)).toEqual([
            { revision: 1, total: 0, calculated: 0, confirmedBy: person.coordinator },
            { revision: 2, total: 3, calculated: 0, confirmedBy: person.coordinator },
          ]);
          expect(yield* serviceFacts).toEqual(before);

          // History is append-only: neither a rewrite nor a removal of the first confirmation.
          const rewrite = yield* Effect.exit(
            Database.use(
              (sql) =>
                sql`UPDATE days_served_confirmations SET total = 9 WHERE person_id = ${person.bo}`,
            ),
          );

          const removal = yield* Effect.exit(
            Database.use(
              (sql) => sql`DELETE FROM days_served_confirmations WHERE person_id = ${person.bo}`,
            ),
          );

          expect(Exit.isFailure(rewrite)).toBe(true);
          expect(Exit.isFailure(removal)).toBe(true);

          // A precondition that saw the entry before both confirmations writes nothing.
          const stale = daysServedEntryVersion(initial ?? corrected);
          const reader = yield* principal(person.coordinator);

          const rejected = yield* Effect.flip(
            transaction(
              Placements.use((placements) =>
                placements.confirmDaysServed(
                  reader,
                  {
                    commandId: nextCommandId(),
                    departmentId: trondheim,
                    semesterId: autumn,
                    personId: person.bo,
                    total: 5,
                  },
                  (current) =>
                    daysServedEntryVersion(current) === stale
                      ? Effect.void
                      : Effect.fail("precondition.failed" as const),
                ),
              ),
            ),
          );

          expect(rejected).toBe("precondition.failed");
          expect(yield* confirmationRows(person.bo)).toHaveLength(2);

          // Without the delegated capability a team leader confirms nothing.
          const denied = yield* Effect.flip(confirm(person.itLeader, autumn, person.bo, 1));

          expect(denied).toEqual(new CertificateAccessDenied({ reason: "NotInScope" }));
          expect(yield* confirmationRows(person.bo)).toHaveLength(2);
        }),
    );

    it.effect(
      "lists only the confirmed semesters of the issuer's department, each with its confirmed total, and records every issue",
      () =>
        Effect.gen(function* () {
          const unconfirmed = yield* readCertificate(person.styretLeader, trondheim, person.ada);

          expect(unconfirmed.content).toBeNull();
          expect(
            unconfirmed.semesters.map(({ semesterId, status }) => ({ semesterId, status })),
          ).toEqual([
            { semesterId: spring, status: "Unconfirmed" },
            { semesterId: autumn, status: "Unconfirmed" },
          ]);
          expect(yield* Effect.flip(issue(person.styretLeader, trondheim, person.ada))).toEqual(
            new CertificateEmpty(),
          );

          // Spring as calculated, autumn adjusted above its count of one; Ås confirms its own.
          yield* confirm(person.coordinator, spring, person.ada, 6);
          yield* confirm(person.coordinator, autumn, person.ada, 2);
          yield* confirm(person.administrator, spring, person.ada, 3, aas);

          const preview = yield* readCertificate(person.styretLeader, trondheim, person.ada);

          expect(preview.content).toEqual({
            personId: person.ada,
            assistantName: "Ada Assistent",
            departmentId: trondheim,
            departmentName: "Trondheim",
            semesters: [
              {
                semesterId: spring,
                startsOn: "2026-01-01",
                endsOn: "2026-08-01",
                schools: ["Lade skole"],
                days: 6,
              },
              {
                semesterId: autumn,
                startsOn: "2026-08-01",
                endsOn: "2026-12-31",
                schools: ["Lade skole"],
                days: 2,
              },
            ],
          });

          const before = yield* serviceFacts;
          const first = yield* issue(person.styretLeader, trondheim, person.ada);
          const second = yield* issue(person.styretLeader, trondheim, person.ada);

          // Two downloads of unchanged confirmed data: two records, one content hash.
          expect(first.contentSha256).toBe(preview.contentSha256);
          expect(second.contentSha256).toBe(preview.contentSha256);
          expect(first.issueId).not.toBe(second.issueId);
          expect(first.issuer).toEqual({
            personId: person.styretLeader,
            name: "Siri Styreleder",
            seatTitle: "Styreleder, Styret",
            basis: "BoardSeat",
          });

          const recorded = yield* issueRows(person.ada);

          expect(recorded).toHaveLength(2);
          expect(recorded.map((row) => row.contentSha256)).toEqual([
            preview.contentSha256,
            preview.contentSha256,
          ]);
          expect(recorded[0]).toMatchObject({
            departmentId: trondheim,
            issuedBy: person.styretLeader,
            issuerName: "Siri Styreleder",
            seatTitle: "Styreleder, Styret",
            basis: "BoardSeat",
          });
          expect(yield* serviceFacts).toEqual(before);

          // A correction gives new content and a new hash; the earlier issues keep theirs.
          yield* confirm(person.coordinator, autumn, person.ada, 1);

          const corrected = yield* issue(person.styretLeader, trondheim, person.ada);

          expect(corrected.content.semesters.map((semester) => semester.days)).toEqual([6, 1]);
          expect(corrected.contentSha256).not.toBe(preview.contentSha256);
          expect((yield* issueRows(person.ada)).map((row) => row.contentSha256)).toEqual([
            preview.contentSha256,
            preview.contentSha256,
            corrected.contentSha256,
          ]);
        }),
    );

    it.effect(
      "lets exactly the seats of journey 3 issue, and records nothing for a denied issuer",
      () =>
        Effect.gen(function* () {
          const cases = [
            [trondheim, person.styretLeader, "BoardSeat", "Styreleder, Styret"],
            [trondheim, person.styretMember, "BoardSeat", "Nestleder, Styret"],
            [trondheim, person.itLeader, "DerivedSeat", "Leder, IT"],
            [trondheim, person.administrator, "GlobalAdministrator", "Global administrator"],
            [trondheim, person.hsMember, null, null],
            [trondheim, person.nationalLeader, null, null],
            [trondheim, person.aasLeader, null, null],
            [trondheim, person.itMember, null, null],
            [trondheim, person.coordinator, null, null],
            [aas, person.hsMember, "BoardSeat", "Styremedlem, Hovedstyret"],
            [aas, person.nationalLeader, "DerivedSeat", "Leder, Rekruttering nasjonalt"],
            [aas, person.administrator, "GlobalAdministrator", "Global administrator"],
            [aas, person.styretLeader, null, null],
            [aas, person.styretMember, null, null],
            [aas, person.itLeader, null, null],
            // A team leader of a department that is not independent sits on no issuing board.
            [aas, person.aasLeader, null, null],
            [aas, person.itMember, null, null],
          ] as const;

          const observed = yield* Effect.forEach(cases, ([departmentId, issuer]) =>
            issue(issuer, departmentId, person.cato).pipe(
              Effect.map((issued) => ({
                basis: issued.issuer.basis,
                seatTitle: issued.issuer.seatTitle,
                departments: [issued.content.departmentId],
              })),
              Effect.catchTag("CertificateAccessDenied", (denied) =>
                Effect.succeed({ basis: null, seatTitle: null, departments: [denied.reason] }),
              ),
            ),
          );

          expect(observed).toEqual(
            cases.map(([departmentId, , basis, seatTitle]) => ({
              basis,
              seatTitle,
              departments: [basis === null ? "NotInScope" : departmentId],
            })),
          );

          const recorded = yield* issueRows(person.cato);

          expect(recorded.map((row) => [row.departmentId, row.issuedBy])).toEqual(
            cases.flatMap(([departmentId, issuer, basis]) =>
              basis === null ? [] : [[departmentId, issuer]],
            ),
          );
        }),
    );

    it.effect(
      "shows a derived seat on the roster without storing it, gives it no administration, and drops it with the leadership",
      () =>
        Effect.gen(function* () {
          const rosters = (reader: PersonId) =>
            Organization.use((organization) => organization.readBoardRosters(reader));

          const styret = (yield* rosters(person.styretLeader)).boards;

          expect(styret.map((board) => board.name)).toEqual(["Styret"]);
          expect(styret[0]?.seats).toEqual([
            BoardRosterSeat.cases.AppointedSeat.make({
              personId: person.styretLeader,
              name: "Siri Styreleder",
              appointmentId: "cert-m-styret-leader",
              position: "Styreleder",
            }),
            BoardRosterSeat.cases.AppointedSeat.make({
              personId: person.styretMember,
              name: "Sverre Styremedlem",
              appointmentId: "cert-m-styret-member",
              position: "Nestleder",
            }),
            BoardRosterSeat.cases.DerivedSeat.make({
              personId: person.eventLeader,
              name: "Eva Arrangementsleder",
              sourceAppointmentId: "cert-m-event-leader",
              sourceTeamId: TeamId.make("cert-event"),
              sourceTeamName: "Arrangement",
            }),
            BoardRosterSeat.cases.DerivedSeat.make({
              personId: person.itLeader,
              name: "Ivar Itleder",
              sourceAppointmentId: "cert-m-it-leader",
              sourceTeamId: TeamId.make("cert-it"),
              sourceTeamName: "IT",
            }),
          ]);

          const all = (yield* rosters(person.administrator)).boards;

          expect(all.map((board) => board.name)).toEqual(["Hovedstyret", "Styret"]);
          expect(all[0]?.seats.map((seat) => [seat._tag, seat.personId])).toEqual([
            ["AppointedSeat", person.hsMember],
            ["DerivedSeat", person.nationalLeader],
          ]);

          // The derived seat is no appointment, and it administers nothing.
          const stored = yield* Database.use(
            (sql) => sql`SELECT team_id AS "teamId", board_id AS "boardId"
              FROM organization_memberships WHERE person_id = ${person.eventLeader}`,
          );

          expect(stored).toEqual([{ teamId: "cert-event", boardId: null }]);
          expect((yield* rosters(person.eventLeader)).boards).toEqual([]);
          expect(yield* Effect.flip(readDaysServed(person.eventLeader, autumn))).toEqual(
            new CertificateAccessDenied({ reason: "NotInScope" }),
          );

          const { authorizationInstant } = yield* principal(person.eventLeader);

          const authority = yield* Organization.use((organization) =>
            organization.resolvePersonAuthority(person.eventLeader, authorizationInstant),
          );

          expect(authority.globalAdministrator).toBe("Absent");

          const issued = yield* issue(person.eventLeader, trondheim, person.cato);

          expect(issued.issuer).toMatchObject({
            basis: "DerivedSeat",
            seatTitle: "Leder, Arrangement",
          });

          // The leadership ends: the seat leaves the roster, and the next issue is denied.
          yield* Database.use(
            (sql) => sql`UPDATE organization_memberships
              SET end_at = date_trunc('milliseconds', now(), 'UTC')
              WHERE membership_id = 'cert-m-event-leader'`,
          );

          const after = (yield* rosters(person.styretLeader)).boards[0]?.seats ?? [];

          expect(after.map((seat) => seat.personId)).not.toContain(person.eventLeader);
          expect(yield* Effect.flip(issue(person.eventLeader, trondheim, person.cato))).toEqual(
            new CertificateAccessDenied({ reason: "NotInScope" }),
          );
        }),
    );

    it.effect("never lets the assistant read or issue their own certificate", () =>
      Effect.gen(function* () {
        // An assistant without a seat is no issuer.
        expect(yield* Effect.flip(readCertificate(person.ada, trondheim, person.ada))).toEqual(
          new CertificateAccessDenied({ reason: "NotInScope" }),
        );
        // An issuing seat does not reach the holder's own certificate.
        expect(
          yield* Effect.flip(readCertificate(person.styretMember, trondheim, person.styretMember)),
        ).toEqual(new CertificateAccessDenied({ reason: "OwnCertificate" }));
        expect(
          yield* Effect.flip(issue(person.styretMember, trondheim, person.styretMember)),
        ).toEqual(new CertificateAccessDenied({ reason: "OwnCertificate" }));
        expect(yield* issueRows(person.styretMember)).toEqual([]);

        // The table refuses a self-issue that bypasses the service.
        const [recorded] = yield* issueRows(person.ada);

        const selfIssue = yield* Effect.flip(
          Database.use(
            (
              sql,
            ) => sql`INSERT INTO certificate_issues (issue_id,person_id,department_id,content_json,
              content_sha256,issued_at,issued_by_person_id,issuer_name,seat_title,issuer_basis)
              VALUES (${`certificate-issue-${nextCommandId()}`},${person.ada},${trondheim},
                ${sql.json(Option.getOrThrow(Option.fromNullishOr(recorded?.content)))},
                ${"0".repeat(64)},'2026-09-20T12:00:00.000Z',${person.ada},'Ada Assistent',
                'Styremedlem, Styret','BoardSeat')`,
          ),
        );

        expect(selfIssue.reason).toBeInstanceOf(ConstraintError);
        expect(selfIssue.reason.cause).toMatchObject({
          code: "23514",
          constraint: "certificate_issues_not_own",
        });
      }),
    );
  },
);
