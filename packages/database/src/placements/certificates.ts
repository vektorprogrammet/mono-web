/**
 * PostgreSQL adapter of days served and certificates. It reads the counted service facts,
 * appends attributable confirmations, and records certificate issues. It never writes a
 * placement, a commitment, a decision, an occurrence, or legacy history.
 */
import { Effect, Option, Predicate, Schema } from "effect";
import { SqlSchema } from "effect/unstable/sql";
import { isSqlError } from "effect/unstable/sql/SqlError";
import { certificateIssuerBasis, reaches, ReachTarget } from "@vektorprogrammet/domain/authz";
import {
  DepartmentId,
  PersonId,
  SemesterId,
  type CertificateIssuer,
  type OrganizationPersonAuthority,
} from "@vektorprogrammet/domain/organization";
import {
  AssistantCursorPosition,
  assistantPage,
  calculatedDaysServed,
  CertificateAccessDenied,
  CertificateAssistant,
  CertificateAssistantNotFound,
  certificateContent,
  CertificateContent,
  certificateContentSha256,
  CertificateEmpty,
  CertificateIssue,
  CertificatePersistenceError,
  CertificatePreview,
  CertificateScopeNotFound,
  CertificateScopes,
  certificateSemesterStatuses,
  DAYS_SERVED_PAGE_SIZE,
  DaysServedConfirmationId,
  DaysServedEntry,
  DaysServedEvidence,
  daysServedEvidence,
  daysServedEvidenceSha256,
  decodeAssistantCursor,
  evidenceSchools,
  IsoServiceDate,
  type CertificatePrincipal,
  type ConfirmDaysServedCommand,
  type CountedAttendance,
  type IssueCertificateCommand,
  type LegacyWorkdayTotal,
  type PlacementScope,
  type SemesterService,
} from "@vektorprogrammet/domain/placements";
import { SchoolId } from "@vektorprogrammet/domain/schools";
import { canonicalJsonValue } from "@vektorprogrammet/domain/shared-kernel";
import {
  certificateIssuerWithSql,
  lockPersonAuthorization,
  readGovernedDepartmentsWithSql,
  resolveOrganizationPersonAuthorityWithSql,
} from "../organization/authority-postgres.js";
import { Database, type DatabaseOperations } from "../service.js";

const conflict = (cause: unknown, depth: number): boolean =>
  depth < 8 &&
  ((isSqlError(cause) &&
    (Predicate.isTagged(cause.reason, "SerializationError") ||
      Predicate.isTagged(cause.reason, "DeadlockError"))) ||
    (Predicate.hasProperty(cause, "cause") && conflict(cause.cause, depth + 1)));

/** Keeps the cause private and marks serialization and deadlock aborts as retryable conflicts. */
const persistenceFailure =
  (operation: string) =>
  (cause: unknown): CertificatePersistenceError =>
    new CertificatePersistenceError({ operation, conflict: conflict(cause, 0), cause });

const SemesterRow = Schema.Struct({
  semesterId: SemesterId,
  startAt: Schema.String,
  endAt: Schema.String,
  startsOn: IsoServiceDate,
  endsOn: IsoServiceDate,
});

/** Semesters with their UTC bounds and their Oslo dates, newest first. */
const findSemesters = SqlSchema.findAll({
  Request: Schema.NullOr(Schema.Array(SemesterId)),
  Result: SemesterRow,
  execute: (semesterIds) =>
    Database.use(
      (sql) => sql`
        SELECT
          semester_id AS "semesterId",
          to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
          to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endAt",
          to_char(start_at AT TIME ZONE 'Europe/Oslo', 'YYYY-MM-DD') AS "startsOn",
          to_char(end_at AT TIME ZONE 'Europe/Oslo', 'YYYY-MM-DD') AS "endsOn"
        FROM public.admission_period_semesters
        WHERE ${semesterIds === null ? sql`TRUE` : sql.in("semester_id", semesterIds)}
        ORDER BY start_at DESC, semester_id
      `,
    ),
});

const DepartmentRow = Schema.Struct({ departmentId: DepartmentId, name: Schema.String });

/** One department; `lock` takes the department lock that every Placements command holds. */
const findDepartment = SqlSchema.findOneOption({
  Request: Schema.Struct({ departmentId: DepartmentId, lock: Schema.Boolean }),
  Result: DepartmentRow,
  execute: ({ departmentId, lock }) =>
    Database.use(
      (sql) => sql`
        SELECT department_id AS "departmentId", name
        FROM public.organization_departments
        WHERE department_id = ${departmentId}
        ${lock ? sql`FOR UPDATE` : sql``}
      `,
    ),
});

const FactsRequest = Schema.Struct({
  departmentId: DepartmentId,
  semesterId: Schema.NullOr(SemesterId),
  personIds: Schema.Array(PersonId),
});

/** Attendance recorded at completed dated service: the only attendance that counts. */
const findAttendance = SqlSchema.findAll({
  Request: FactsRequest,
  Result: Schema.Struct({
    personId: PersonId,
    semesterId: SemesterId,
    serviceDate: IsoServiceDate,
    schoolId: SchoolId,
    schoolName: Schema.String,
  }),
  execute: ({ departmentId, semesterId, personIds }) =>
    Database.use(
      (sql) => sql`
        SELECT
          attendee.person_id AS "personId",
          commitment.semester_id AS "semesterId",
          to_char(commitment.service_date, 'YYYY-MM-DD') AS "serviceDate",
          commitment.school_id::double precision AS "schoolId",
          commitment.school_name AS "schoolName"
        FROM public.school_service_decisions AS decision
        INNER JOIN public.school_service_commitments AS commitment
          ON commitment.commitment_id = decision.commitment_id
        CROSS JOIN LATERAL jsonb_array_elements_text(decision.attended_person_ids)
          AS attendee(person_id)
        WHERE decision.outcome = 'Completed'
          AND commitment.department_id = ${departmentId}
          AND (${semesterId}::text IS NULL OR commitment.semester_id = ${semesterId})
          AND ${sql.in("attendee.person_id", personIds)}
        ORDER BY 1, 2, 3, 4
      `,
    ),
});

/** Accepted legacy workday totals: import accepts only reconciled persons and rows. */
const findLegacyTotals = SqlSchema.findAll({
  Request: FactsRequest,
  Result: Schema.Struct({
    personId: PersonId,
    semesterId: SemesterId,
    schoolId: SchoolId,
    schoolName: Schema.String,
    workdays: Schema.Int,
  }),
  execute: ({ departmentId, semesterId, personIds }) =>
    Database.use(
      (sql) => sql`
        SELECT
          history.person_id AS "personId",
          history.semester_id AS "semesterId",
          history.school_id::double precision AS "schoolId",
          school.name AS "schoolName",
          history.workdays
        FROM public.assistant_service_history AS history
        INNER JOIN public.schools_directory_schools AS school ON school.school_id = history.school_id
        WHERE history.department_id = ${departmentId}
          AND (${semesterId}::text IS NULL OR history.semester_id = ${semesterId})
          AND ${sql.in("history.person_id", personIds)}
        ORDER BY 1, 2, 3, history.source_history_id
      `,
    ),
});

const ConfirmationRow = Schema.Struct({
  personId: PersonId,
  semesterId: SemesterId,
  confirmationId: DaysServedConfirmationId,
  revision: Schema.Int,
  total: Schema.Int,
  calculated: Schema.Int,
  evidence: DaysServedEvidence,
  confirmedAt: Schema.String,
  confirmedBy: PersonId,
  confirmedByName: Schema.String,
});

type ConfirmationRow = typeof ConfirmationRow.Type;

/** The current confirmation of each person and semester: its latest revision. */
const findConfirmations = SqlSchema.findAll({
  Request: FactsRequest,
  Result: ConfirmationRow,
  execute: ({ departmentId, semesterId, personIds }) =>
    Database.use(
      (sql) => sql`
        SELECT DISTINCT ON (confirmation.person_id, confirmation.semester_id)
          confirmation.person_id AS "personId",
          confirmation.semester_id AS "semesterId",
          confirmation.confirmation_id AS "confirmationId",
          confirmation.revision,
          confirmation.total,
          confirmation.calculated,
          confirmation.evidence_json AS evidence,
          to_char(confirmation.confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            AS "confirmedAt",
          confirmation.confirmed_by_person_id AS "confirmedBy",
          confirmer.first_name || ' ' || confirmer.last_name AS "confirmedByName"
        FROM public.days_served_confirmations AS confirmation
        INNER JOIN public.person_profiles AS confirmer
          ON confirmer.person_id = confirmation.confirmed_by_person_id
        WHERE confirmation.department_id = ${departmentId}
          AND (${semesterId}::text IS NULL OR confirmation.semester_id = ${semesterId})
          AND ${sql.in("confirmation.person_id", personIds)}
        ORDER BY confirmation.person_id, confirmation.semester_id, confirmation.revision DESC
      `,
    ),
});

/** Semesters where a person holds an active placement: they need a confirmation, zero included. */
const findPlacedSemesters = SqlSchema.findAll({
  Request: FactsRequest,
  Result: Schema.Struct({ personId: PersonId, semesterId: SemesterId }),
  execute: ({ departmentId, semesterId, personIds }) =>
    Database.use(
      (sql) => sql`
        SELECT DISTINCT person_id AS "personId", semester_id AS "semesterId"
        FROM public.assistant_placements
        WHERE department_id = ${departmentId}
          AND active
          AND (${semesterId}::text IS NULL OR semester_id = ${semesterId})
          AND ${sql.in("person_id", personIds)}
        ORDER BY 1, 2
      `,
    ),
});

const AssistantRow = Schema.Struct({
  personId: PersonId,
  firstName: Schema.String,
  lastName: Schema.String,
});

type AssistantRow = typeof AssistantRow.Type;

/**
 * The assistants of a department, in one semester or in any: everyone with counted attendance,
 * an accepted legacy total, an active placement, or a confirmation there. One page past the
 * cursor, ordered by name, or the one named person.
 */
const findAssistants = SqlSchema.findAll({
  Request: Schema.Struct({
    departmentId: DepartmentId,
    semesterId: Schema.NullOr(SemesterId),
    after: Schema.NullOr(AssistantCursorPosition),
    personId: Schema.NullOr(PersonId),
  }),
  Result: AssistantRow,
  execute: ({ departmentId, semesterId, after, personId }) =>
    Database.use(
      (sql) => sql`
        WITH people(person_id) AS (
          SELECT attendee.person_id
          FROM public.school_service_decisions AS decision
          INNER JOIN public.school_service_commitments AS commitment
            ON commitment.commitment_id = decision.commitment_id
          CROSS JOIN LATERAL jsonb_array_elements_text(decision.attended_person_ids)
            AS attendee(person_id)
          WHERE decision.outcome = 'Completed'
            AND commitment.department_id = ${departmentId}
            AND (${semesterId}::text IS NULL OR commitment.semester_id = ${semesterId})
          UNION
          SELECT person_id FROM public.assistant_service_history
          WHERE department_id = ${departmentId}
            AND (${semesterId}::text IS NULL OR semester_id = ${semesterId})
          UNION
          SELECT person_id FROM public.assistant_placements
          WHERE department_id = ${departmentId} AND active
            AND (${semesterId}::text IS NULL OR semester_id = ${semesterId})
          UNION
          SELECT person_id FROM public.days_served_confirmations
          WHERE department_id = ${departmentId}
            AND (${semesterId}::text IS NULL OR semester_id = ${semesterId})
        )
        SELECT
          profile.person_id AS "personId",
          profile.first_name AS "firstName",
          profile.last_name AS "lastName"
        FROM people
        INNER JOIN public.person_profiles AS profile ON profile.person_id = people.person_id
        WHERE (${personId}::text IS NULL OR profile.person_id = ${personId})
          AND ${
            after === null
              ? sql`TRUE`
              : sql`(profile.last_name, profile.first_name, profile.person_id) >
                  (${after.lastName}, ${after.firstName}, ${after.personId})`
          }
        ORDER BY profile.last_name, profile.first_name, profile.person_id
        LIMIT ${DAYS_SERVED_PAGE_SIZE + 1}
      `,
    ),
});

/** The service of one person in one semester of a department. */
interface Service {
  readonly personId: PersonId;
  readonly semesterId: SemesterId;
  readonly evidence: DaysServedEvidence;
  readonly confirmation: Option.Option<ConfirmationRow>;
}

const serviceKey = (personId: string, semesterId: string) => `${personId}\u0000${semesterId}`;

/** The facts of one person in one semester while they are read. */
interface ServiceFacts {
  readonly personId: PersonId;
  readonly semesterId: SemesterId;
  readonly attendance: Array<CountedAttendance>;
  readonly legacy: Array<LegacyWorkdayTotal>;
  confirmation: ConfirmationRow | undefined;
}

/** Every service fact of these persons in the department, in one semester or in each. */
const readServices = (
  departmentId: DepartmentId,
  semesterId: SemesterId | null,
  personIds: ReadonlyArray<PersonId>,
) =>
  Effect.gen(function* () {
    const request = { departmentId, semesterId, personIds };
    const attendance = yield* findAttendance(request);
    const legacy = yield* findLegacyTotals(request);
    const confirmations = yield* findConfirmations(request);
    const placed = yield* findPlacedSemesters(request);

    const facts = new Map<string, ServiceFacts>();

    const factsOf = (row: { readonly personId: PersonId; readonly semesterId: SemesterId }) => {
      const key = serviceKey(row.personId, row.semesterId);
      const known = facts.get(key);

      if (known !== undefined) return known;

      const created: ServiceFacts = {
        personId: row.personId,
        semesterId: row.semesterId,
        attendance: [],
        legacy: [],
        confirmation: undefined,
      };

      facts.set(key, created);

      return created;
    };

    for (const row of attendance)
      factsOf(row).attendance.push({
        serviceDate: row.serviceDate,
        school: { schoolId: row.schoolId, name: row.schoolName },
      });

    for (const row of legacy)
      factsOf(row).legacy.push({
        school: { schoolId: row.schoolId, name: row.schoolName },
        workdays: row.workdays,
      });

    for (const row of confirmations) factsOf(row).confirmation = row;

    for (const row of placed) factsOf(row);

    return new Map(
      [...facts].map(([key, fact]): readonly [string, Service] => [
        key,
        {
          personId: fact.personId,
          semesterId: fact.semesterId,
          evidence: daysServedEvidence(fact.attendance, fact.legacy),
          confirmation: Option.fromUndefinedOr(fact.confirmation),
        },
      ]),
    );
  });

const entryOf = (
  assistant: AssistantRow,
  scope: PlacementScope,
  service: Service | undefined,
): DaysServedEntry => {
  const evidence = service?.evidence ?? daysServedEvidence([], []);
  const confirmation = Option.getOrNull(service?.confirmation ?? Option.none());

  return {
    personId: assistant.personId,
    firstName: assistant.firstName,
    lastName: assistant.lastName,
    departmentId: scope.departmentId,
    semesterId: scope.semesterId,
    evidence,
    calculated: calculatedDaysServed(evidence),
    revision: confirmation?.revision ?? 0,
    confirmation:
      confirmation === null
        ? null
        : {
            confirmationId: confirmation.confirmationId,
            revision: confirmation.revision,
            total: confirmation.total,
            calculated: confirmation.calculated,
            confirmedAt: confirmation.confirmedAt,
            confirmedBy: confirmation.confirmedBy,
            confirmedByName: confirmation.confirmedByName,
          },
  };
};

/** Resolves current authority on the caller's transaction; a command holds the person lock. */
const resolveAuthority = (
  sql: DatabaseOperations,
  principal: CertificatePrincipal,
  command: boolean,
) =>
  Effect.gen(function* () {
    if (command) yield* lockPersonAuthorization(sql, principal.personId);

    return yield* resolveOrganizationPersonAuthorityWithSql(
      sql,
      principal.personId,
      principal.authorizationInstant,
      command ? "ForShare" : "None",
    );
  }).pipe(Effect.mapError(persistenceFailure("resolve certificate authority")));

const requireDaysServedAuthority = (
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId,
) =>
  reaches(authority, "placements.days-served", ReachTarget.Department({ departmentId }))
    ? Effect.void
    : Effect.fail(new CertificateAccessDenied({ reason: "NotInScope" }));

const requireDepartment = (departmentId: DepartmentId, lock: boolean) =>
  findDepartment({ departmentId, lock }).pipe(
    Effect.mapError(persistenceFailure("read certificate department")),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new CertificateScopeNotFound()),
        onSome: Effect.succeed,
      }),
    ),
  );

const requireSemester = (semesterId: SemesterId) =>
  findSemesters([semesterId]).pipe(
    Effect.mapError(persistenceFailure("read certificate semester")),
    Effect.flatMap(([semester]) =>
      semester === undefined
        ? Effect.fail(new CertificateScopeNotFound())
        : Effect.succeed(semester),
    ),
  );

const readEntry = (scope: PlacementScope, personId: PersonId) =>
  Effect.gen(function* () {
    const [assistant] = yield* findAssistants({ ...scope, after: null, personId });

    if (assistant === undefined) return Option.none<DaysServedEntry>();

    const services = yield* readServices(scope.departmentId, scope.semesterId, [personId]);

    return Option.some(
      entryOf(assistant, scope, services.get(serviceKey(personId, scope.semesterId))),
    );
  }).pipe(Effect.mapError(persistenceFailure("read days served")));

/** The issuer of a department's certificates, or a denial for anyone else. */
const requireIssuer = (
  sql: DatabaseOperations,
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId,
  command: boolean,
) =>
  Effect.gen(function* () {
    const [department] = yield* readGovernedDepartmentsWithSql(
      sql,
      departmentId,
      command ? "ForShare" : "None",
    ).pipe(Effect.mapError(persistenceFailure("read governed department")));

    if (department === undefined) return yield* new CertificateScopeNotFound();

    const issuer = yield* certificateIssuerWithSql(sql, authority, department).pipe(
      Effect.mapError(persistenceFailure("read certificate issuer")),
    );

    if (Option.isNone(issuer)) return yield* new CertificateAccessDenied({ reason: "NotInScope" });

    return issuer.value;
  });

/** The certificate of one assistant in the department as the issuer would issue it now. */
const buildPreview = (
  department: typeof DepartmentRow.Type,
  personId: PersonId,
  issuer: CertificateIssuer,
) =>
  Effect.gen(function* () {
    const [assistant] = yield* findAssistants({
      departmentId: department.departmentId,
      semesterId: null,
      after: null,
      personId,
    }).pipe(Effect.mapError(persistenceFailure("read certificate assistant")));

    if (assistant === undefined) return yield* new CertificateAssistantNotFound({ personId });

    const services = [
      ...(yield* readServices(department.departmentId, null, [personId]).pipe(
        Effect.mapError(persistenceFailure("read certificate service")),
      )).values(),
    ];

    const semesters = yield* findSemesters(services.map((service) => service.semesterId)).pipe(
      Effect.mapError(persistenceFailure("read certificate semesters")),
    );

    const semesterServices = services.flatMap((service): ReadonlyArray<SemesterService> => {
      const semester = semesters.find((row) => row.semesterId === service.semesterId);

      return semester === undefined
        ? []
        : [
            {
              semesterId: service.semesterId,
              startsOn: semester.startsOn,
              endsOn: semester.endsOn,
              confirmed: Option.map(service.confirmation, (confirmation) => ({
                total: confirmation.total,
                schools: evidenceSchools(confirmation.evidence),
              })),
              calculated: calculatedDaysServed(service.evidence),
            },
          ];
    });

    const assistantName = `${assistant.firstName} ${assistant.lastName}`;

    const content = certificateContent({
      personId,
      assistantName,
      departmentId: department.departmentId,
      departmentName: department.name,
      services: semesterServices,
    });

    return yield* CertificatePreview.makeEffect({
      personId,
      assistantName,
      departmentId: department.departmentId,
      departmentName: department.name,
      semesters: certificateSemesterStatuses(semesterServices),
      content: Option.getOrNull(content),
      contentSha256: Option.getOrNull(Option.map(content, certificateContentSha256)),
      issuer,
    }).pipe(Effect.mapError(persistenceFailure("build certificate preview")));
  });

/** The departments where the principal confirms days served or issues certificates. */
export const readCertificateScopes = (principal: CertificatePrincipal) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const authority = yield* resolveAuthority(sql, principal, false);

    const departments = yield* readGovernedDepartmentsWithSql(sql, null, "None").pipe(
      Effect.mapError(persistenceFailure("read certificate departments")),
    );

    const semesters = yield* findSemesters(null).pipe(
      Effect.mapError(persistenceFailure("read certificate semesters")),
    );

    return yield* CertificateScopes.makeEffect({
      departments: departments.flatMap((department) => {
        const confirmDaysServed = reaches(
          authority,
          "placements.days-served",
          ReachTarget.Department({ departmentId: department.departmentId }),
        );

        const issueCertificates = Option.isSome(certificateIssuerBasis(authority, department));

        return confirmDaysServed || issueCertificates
          ? [
              {
                departmentId: department.departmentId,
                name: department.name,
                confirmDaysServed,
                issueCertificates,
              },
            ]
          : [];
      }),
      semesters: semesters.map(({ semesterId, startAt, endAt }) => ({
        semesterId,
        startAt,
        endAt,
      })),
    }).pipe(Effect.mapError(persistenceFailure("build certificate scopes")));
  });

/** One page of the assistants of a department and semester with their days served. */
export const readDaysServed = (
  principal: CertificatePrincipal,
  scope: PlacementScope,
  cursor?: string,
) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const position = cursor === undefined ? null : yield* decodeAssistantCursor(cursor);
    const department = yield* requireDepartment(scope.departmentId, false);
    const semester = yield* requireSemester(scope.semesterId);
    const authority = yield* resolveAuthority(sql, principal, false);

    yield* requireDaysServedAuthority(authority, scope.departmentId);

    const rows = yield* findAssistants({ ...scope, after: position, personId: null }).pipe(
      Effect.mapError(persistenceFailure("list days served")),
    );

    const page = assistantPage(rows, (row) => row);

    const services = yield* readServices(
      scope.departmentId,
      scope.semesterId,
      page.items.map((row) => row.personId),
    ).pipe(Effect.mapError(persistenceFailure("read days served")));

    return {
      ...page,
      items: page.items.map((row) =>
        entryOf(row, scope, services.get(serviceKey(row.personId, scope.semesterId))),
      ),
      departmentName: department.name,
      semester: {
        semesterId: semester.semesterId,
        startAt: semester.startAt,
        endAt: semester.endAt,
      },
    };
  });

/**
 * Appends the next confirmation of one assistant's total under the department lock. The
 * precondition sees the fresh entry; the earlier confirmations and the service facts stay.
 */
export const confirmDaysServed = <E, R>(
  principal: CertificatePrincipal,
  command: ConfirmDaysServedCommand,
  checkPrecondition: (current: DaysServedEntry) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const scope = { departmentId: command.departmentId, semesterId: command.semesterId };

    yield* requireDepartment(command.departmentId, true);
    yield* requireSemester(command.semesterId);

    const authority = yield* resolveAuthority(sql, principal, true);

    yield* requireDaysServedAuthority(authority, command.departmentId);

    const current = yield* readEntry(scope, command.personId);

    if (Option.isNone(current))
      return yield* new CertificateAssistantNotFound({ personId: command.personId });

    yield* checkPrecondition(current.value);

    const evidence = yield* Schema.encodeEffect(DaysServedEvidence)(current.value.evidence).pipe(
      Effect.mapError(persistenceFailure("encode days-served evidence")),
    );

    yield* sql`
      INSERT INTO public.days_served_confirmations (
        confirmation_id, person_id, department_id, semester_id, revision, total, calculated,
        evidence_json, evidence_sha256, confirmed_at, confirmed_by_person_id
      ) VALUES (
        ${`days-served-confirmation-${command.commandId}`}, ${command.personId},
        ${command.departmentId}, ${command.semesterId}, ${current.value.revision + 1},
        ${command.total}, ${current.value.calculated}, ${sql.json(canonicalJsonValue(evidence))},
        ${daysServedEvidenceSha256(current.value.evidence)}, ${principal.authorizationInstant},
        ${principal.personId}
      )
    `.pipe(Effect.mapError(persistenceFailure("insert days-served confirmation")));

    const confirmed = yield* readEntry(scope, command.personId);

    if (Option.isNone(confirmed))
      return yield* new CertificateAssistantNotFound({ personId: command.personId });

    return confirmed.value;
  });

/** One page of the assistants with service facts in a department, for its issuers. */
export const listCertificates = (
  principal: CertificatePrincipal,
  departmentId: DepartmentId,
  cursor?: string,
) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const position = cursor === undefined ? null : yield* decodeAssistantCursor(cursor);
    const department = yield* requireDepartment(departmentId, false);
    const authority = yield* resolveAuthority(sql, principal, false);

    yield* requireIssuer(sql, authority, departmentId, false);

    const rows = yield* findAssistants({
      departmentId,
      semesterId: null,
      after: position,
      personId: null,
    }).pipe(Effect.mapError(persistenceFailure("list certificate assistants")));

    const page = assistantPage(rows, (row) => row);

    const services = [
      ...(yield* readServices(
        departmentId,
        null,
        page.items.map((row) => row.personId),
      ).pipe(Effect.mapError(persistenceFailure("read certificate service")))).values(),
    ];

    const items = yield* Effect.forEach(page.items, (row) => {
      const statuses = services.flatMap((service) =>
        service.personId === row.personId
          ? [
              Option.match(service.confirmation, {
                onNone: () => "Unconfirmed" as const,
                onSome: (confirmation) =>
                  confirmation.total > 0 ? ("Included" as const) : ("ConfirmedZero" as const),
              }),
            ]
          : [],
      );

      return CertificateAssistant.makeEffect({
        ...row,
        includedSemesters: statuses.filter((status) => status === "Included").length,
        unconfirmedSemesters: statuses.filter((status) => status === "Unconfirmed").length,
      }).pipe(Effect.mapError(persistenceFailure("build certificate assistant")));
    });

    return { ...page, items, departmentName: department.name };
  });

/** The certificate that the principal would issue now, and the semesters it leaves out. */
export const readCertificate = (
  principal: CertificatePrincipal,
  departmentId: DepartmentId,
  personId: PersonId,
) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const department = yield* requireDepartment(departmentId, false);
    const authority = yield* resolveAuthority(sql, principal, false);
    const issuer = yield* requireIssuer(sql, authority, departmentId, false);

    if (personId === principal.personId)
      return yield* new CertificateAccessDenied({ reason: "OwnCertificate" });

    return yield* buildPreview(department, personId, issuer);
  });

/**
 * Records one issue of the current certificate under the department lock: who issued it, when,
 * under which seat, and the hash of the content. The precondition sees the fresh preview.
 */
export const issueCertificate = <E, R>(
  principal: CertificatePrincipal,
  command: IssueCertificateCommand,
  checkPrecondition: (current: CertificatePreview) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const department = yield* requireDepartment(command.departmentId, true);
    const authority = yield* resolveAuthority(sql, principal, true);
    const issuer = yield* requireIssuer(sql, authority, command.departmentId, true);

    if (command.personId === principal.personId)
      return yield* new CertificateAccessDenied({ reason: "OwnCertificate" });

    const preview = yield* buildPreview(department, command.personId, issuer);

    yield* checkPrecondition(preview);

    if (preview.content === null || preview.contentSha256 === null)
      return yield* new CertificateEmpty();

    const content = yield* Schema.encodeEffect(CertificateContent)(preview.content).pipe(
      Effect.mapError(persistenceFailure("encode certificate content")),
    );

    const issueId = `certificate-issue-${command.commandId}`;

    const [issued] = yield* sql<{ readonly issuedOn: string }>`
      INSERT INTO public.certificate_issues (
        issue_id, person_id, department_id, content_json, content_sha256, issued_at,
        issued_by_person_id, issuer_name, seat_title, issuer_basis
      ) VALUES (
        ${issueId}, ${command.personId}, ${command.departmentId},
        ${sql.json(canonicalJsonValue(content))}, ${preview.contentSha256},
        ${principal.authorizationInstant}, ${principal.personId}, ${issuer.name},
        ${issuer.seatTitle}, ${issuer.basis}
      )
      RETURNING to_char(issued_at AT TIME ZONE 'Europe/Oslo', 'YYYY-MM-DD') AS "issuedOn"
    `.pipe(Effect.mapError(persistenceFailure("insert certificate issue")));

    return yield* Schema.decodeUnknownEffect(CertificateIssue)({
      issueId,
      content,
      contentSha256: preview.contentSha256,
      issuedAt: principal.authorizationInstant,
      issuedOn: issued?.issuedOn,
      issuer,
    }).pipe(Effect.mapError(persistenceFailure("decode certificate issue")));
  });
