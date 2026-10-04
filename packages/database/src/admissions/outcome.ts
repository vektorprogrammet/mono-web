import { Effect, Option, Predicate, Schema } from "effect";
import { SqlSchema } from "effect/unstable/sql";
import type { OrganizationPersonAuthority, PersonId } from "@vektorprogrammet/domain/organization";
import type { OutcomeMailRenderer } from "@vektorprogrammet/domain/admissions/template";
import {
  AdmissionOutcome,
  AdmissionOutcomeEntry,
  AdmissionOutcomeFailure,
  AdmissionOutcomePersistenceError,
  AdmissionOutcomeScope,
  AdmissionOutcomeScopes,
  admissionOutcomePermission,
  canAnnounceAdmissionOutcome,
  type AdmissionsOperations,
} from "@vektorprogrammet/domain/admissions";
import { Database, type DatabaseOperations } from "../service.js";
import { OutcomeMailQueueFailure, queueOutcomeMail } from "./outcome-mail-queue.js";
import { lockApplicationDecisionWithSql } from "./evidence.js";

const findDepartments = SqlSchema.findAll({
  Request: Schema.Void,
  Result: AdmissionOutcomeScopes.fields.departments.value,
  execute: () =>
    Database.use(
      (sql) => sql`
    SELECT department_id AS "departmentId", name
    FROM public.organization_departments ORDER BY name, department_id`,
    ),
});

const findSemesters = SqlSchema.findAll({
  Request: Schema.Void,
  Result: AdmissionOutcomeScopes.fields.semesters.value,
  execute: () =>
    Database.use(
      (sql) => sql`
    SELECT semester_id AS "semesterId",
      to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
      to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endAt"
    FROM public.admission_period_semesters ORDER BY start_at DESC, semester_id`,
    ),
});

const readScopes = Effect.fnUntraced(function* (authority: OrganizationPersonAuthority) {
  const departments = (yield* findDepartments()).filter(
    (department) =>
      admissionOutcomePermission(authority, department.departmentId) === "Decide" ||
      canAnnounceAdmissionOutcome(authority, department.departmentId),
  );

  if (departments.length === 0)
    return yield* new AdmissionOutcomeFailure({ code: "authority.denied", status: 403 });

  return { departments, semesters: yield* findSemesters() };
});

/** Public outcomes consume the application's canonical evidence view. Closed decisions use
 * their frozen citation; announcements remain final even when live assessment evidence changes.
 * Canonical identity and placement fields remain in their owning tables.
 */
const readRows = SqlSchema.findAll({
  Request: Schema.Union([
    Schema.Struct({ applicationId: AdmissionOutcomeEntry.fields.applicationId }),
    AdmissionOutcomeScope,
  ]),
  Result: AdmissionOutcomeEntry,
  execute: (selection) =>
    Database.use((sql) => {
      const where =
        "applicationId" in selection
          ? sql`application.application_id = ${selection.applicationId}`
          : sql`period.department_id = ${selection.departmentId} AND period.semester_id = ${selection.semesterId}`;

      return sql`
    SELECT application.application_id AS "applicationId", application.admission_period_id AS "admissionPeriodId",
      period.department_id AS "departmentId", period.semester_id AS "semesterId",
      applicant.first_name AS "firstName", applicant.last_name AS "lastName", applicant.email, applicant.phone,
      application.year_of_study AS "yearOfStudy",
      evidence.basis,
      CASE WHEN announcement.application_id IS NULL THEN 'ApplicationSubmitted'
        ELSE 'OutcomeAnnounced' END AS state,
      evidence.outcome,
      EXISTS (
        SELECT 1 FROM public.applicant_account_links AS link
        INNER JOIN public.assistant_placements AS placement ON placement.person_id = link.person_id
        WHERE link.applicant_id = application.applicant_id
          AND placement.department_id = period.department_id
          AND placement.semester_id = period.semester_id AND placement.active
      ) AS placed,
      COALESCE(current.revision, 0) + CASE WHEN announcement.application_id IS NULL THEN 0 ELSE 1 END AS revision
    FROM public.admission_applications AS application
    INNER JOIN public.admission_periods AS period ON period.admission_period_id = application.admission_period_id
      AND period.department_id = application.department_id
    INNER JOIN public.admission_applicants AS applicant ON applicant.applicant_id = application.applicant_id
    INNER JOIN public.application_admission_evidence AS evidence ON evidence.application_id=application.application_id
    LEFT JOIN LATERAL (
      SELECT outcome.outcome, outcome.revision FROM public.admission_application_outcomes AS outcome
      WHERE outcome.application_id = application.application_id
      ORDER BY outcome.revision DESC LIMIT 1
    ) AS current ON true
    LEFT JOIN public.admission_outcome_announcements AS announcement
      ON announcement.application_id = application.application_id
    WHERE ${where} ORDER BY applicant.last_name, applicant.first_name, application.application_id`;
    }),
});

const readEntries = (selection: Parameters<typeof readRows>[0]) => readRows(selection);

const readEntry = (applicationId: AdmissionOutcomeEntry["applicationId"]) =>
  readEntries({ applicationId }).pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.fail(new AdmissionOutcomeFailure({ code: "resource.not-found", status: 404 }))
        : Effect.succeed(rows[0]),
    ),
  );

const findSemester = SqlSchema.findOneOption({
  Request: AdmissionOutcomeScope.fields.semesterId,
  Result: Schema.Struct({ semesterId: AdmissionOutcomeScope.fields.semesterId }),
  execute: (semesterId) =>
    Database.use(
      (sql) => sql`
    SELECT semester_id AS "semesterId" FROM public.admission_period_semesters WHERE semester_id = ${semesterId}`,
    ),
});

const findPeriod = SqlSchema.findOneOption({
  Request: AdmissionOutcomeScope,
  Result: Schema.Struct({ admissionPeriodId: AdmissionOutcomeEntry.fields.admissionPeriodId }),
  execute: (scope) =>
    Database.use(
      (sql) => sql`
    SELECT admission_period_id AS "admissionPeriodId" FROM public.admission_periods
    WHERE department_id = ${scope.departmentId} AND semester_id = ${scope.semesterId}`,
    ),
});

const findApplicationDepartment = SqlSchema.findOneOption({
  Request: AdmissionOutcomeEntry.fields.applicationId,
  Result: Schema.Struct({ departmentId: AdmissionOutcomeEntry.fields.departmentId }),
  execute: (applicationId) =>
    Database.use(
      (sql) => sql`
    SELECT department_id AS "departmentId" FROM public.admission_applications
    WHERE application_id = ${applicationId}`,
    ),
});

const findLatestRevision = SqlSchema.findOneOption({
  Request: AdmissionOutcomeEntry.fields.applicationId,
  Result: Schema.Struct({ outcome: AdmissionOutcome, revision: Schema.Int }),
  execute: (applicationId) =>
    Database.use(
      (sql) => sql`
    SELECT outcome, revision FROM public.admission_application_outcomes
    WHERE application_id = ${applicationId} ORDER BY revision DESC LIMIT 1`,
    ),
});

/** The schools of the person's active placements in the application's department and semester. */
const findPlacementSchoolName = SqlSchema.findOne({
  Request: AdmissionOutcomeEntry.fields.applicationId,
  Result: Schema.Struct({ schoolName: Schema.NullOr(Schema.String) }),
  execute: (applicationId) =>
    Database.use(
      (sql) => sql`
    SELECT string_agg(DISTINCT school.name, ', ' ORDER BY school.name) AS "schoolName"
    FROM public.admission_applications AS application
    INNER JOIN public.admission_periods AS period ON period.admission_period_id = application.admission_period_id
    INNER JOIN public.applicant_account_links AS link ON link.applicant_id = application.applicant_id
    INNER JOIN public.assistant_placements AS placement ON placement.person_id = link.person_id
      AND placement.department_id = period.department_id AND placement.semester_id = period.semester_id
      AND placement.active
    INNER JOIN public.schools_directory_schools AS school ON school.school_id = placement.school_id
    WHERE application.application_id = ${applicationId}`,
    ),
});

/**
 * Appends the next outcome revision and answers its number. A decider makes a `Decision`; no
 * decider makes the `Recommendation` that an interview derived. The database checks that pair.
 */
const appendRevision = (
  applicationId: AdmissionOutcomeEntry["applicationId"],
  outcome: AdmissionOutcome,
  decider: PersonId | null,
  now: string,
) =>
  Effect.gen(function* () {
    const latest = yield* findLatestRevision(applicationId);
    const revision = Option.match(latest, { onNone: () => 0, onSome: (row) => row.revision }) + 1;

    yield* Database.use(
      (sql) => sql`INSERT INTO public.admission_application_outcomes
        (application_id, revision, outcome, decided_by_person_id, decided_at, provenance)
        VALUES (${applicationId}, ${revision}, ${outcome}, ${decider}, ${now},
          ${decider === null ? "Recommendation" : "Decision"})`,
    );

    return revision;
  });

const serializationConflict = (cause: unknown, depth = 0): boolean =>
  depth < 8 &&
  Predicate.isObjectOrArray(cause) &&
  (("code" in cause && (cause.code === "40001" || cause.code === "40P01")) ||
    ("cause" in cause && serializationConflict(cause.cause, depth + 1)));

const persistenceFailure = (cause: unknown) => {
  const conflict = serializationConflict(cause);

  return new AdmissionOutcomePersistenceError({
    code: conflict ? "transaction.conflict" : "internal.error",
    status: conflict ? 409 : 500,
    cause,
  });
};

const refuse = (code: AdmissionOutcomeFailure["code"], status: AdmissionOutcomeFailure["status"]) =>
  new AdmissionOutcomeFailure({ code, status });

/**
 * Takes the lock that serializes this application's outcome with placement writes of the same
 * department, then the application row. The department row lock is the scope lock that
 * `lockPlacementDepartment` takes first in every placement command (`placements/postgres.ts`),
 * so a `Rejected` decision or announcement and a placement create contend on it in either
 * order. Take it before reading placements or outcomes: a waiting statement then reads the
 * committed result of its rival.
 */
const lockOutcomeScope = (applicationId: AdmissionOutcomeEntry["applicationId"]) =>
  Effect.gen(function* () {
    const application = yield* findApplicationDepartment(applicationId);

    if (Option.isNone(application)) return yield* refuse("resource.not-found", 404);

    const department = yield* Database.use(
      (sql) =>
        sql`SELECT department_id FROM public.organization_departments WHERE department_id = ${application.value.departmentId} FOR UPDATE`,
    );

    if (department.length === 0) return yield* refuse("scope.invalid", 422);

    yield* Database.use((sql) => lockApplicationDecisionWithSql(sql, applicationId));
  });

/**
 * Queues the one mail envelope of an announcement in the caller's transaction. A storage
 * failure is a persistence failure; a failure of `render` propagates unchanged.
 */
const queueAnnouncementMail = <E, R>(
  database: DatabaseOperations,
  input: Parameters<typeof queueOutcomeMail>[0],
  render: OutcomeMailRenderer<E, R>,
): Effect.Effect<void, AdmissionOutcomePersistenceError | E, Exclude<R, Database>> =>
  queueOutcomeMail(input, render).pipe(
    Effect.provideService(Database, database),
    Effect.asVoid,
    Effect.mapError((error) =>
      error instanceof OutcomeMailQueueFailure ? persistenceFailure(error.cause) : error,
    ),
  );

/**
 * The admission outcome operations of the Admissions service over the captured Database.
 * They acquire no pool, transaction, or worker; the caller owns the transaction.
 */
export const admissionOutcomeOperations = (
  database: DatabaseOperations,
): Pick<
  AdmissionsOperations,
  | "listAdmissionOutcomeScopes"
  | "readAdmissionOutcomes"
  | "readAdmissionOutcome"
  | "decideAdmissionOutcome"
  | "announceAdmissionOutcome"
> => {
  const run = <A, E>(effect: Effect.Effect<A, E, Database>) =>
    effect.pipe(
      Effect.provideService(Database, database),
      Effect.mapError((cause) =>
        cause instanceof AdmissionOutcomeFailure ? cause : persistenceFailure(cause),
      ),
    );

  return {
    listAdmissionOutcomeScopes: (authority) => run(readScopes(authority)),
    readAdmissionOutcomes: (scope) =>
      run(
        Effect.gen(function* () {
          if (Option.isNone(yield* findSemester(scope.semesterId)))
            return yield* new AdmissionOutcomeFailure({ code: "scope.invalid", status: 422 });
          const period = yield* findPeriod(scope);

          return Option.isSome(period)
            ? {
                admissionPeriodId: period.value.admissionPeriodId,
                entries: yield* readEntries(scope),
              }
            : { admissionPeriodId: null, entries: [] };
        }),
      ),
    readAdmissionOutcome: (applicationId) => run(readEntry(applicationId)),
    decideAdmissionOutcome: ({ applicationId, command, actor, now }, checkPrecondition) =>
      Effect.gen(function* () {
        yield* run(lockOutcomeScope(applicationId));
        const current = yield* run(readEntry(applicationId));
        yield* checkPrecondition(current);

        if (current.state === "OutcomeAnnounced")
          return yield* refuse("admission-outcome.final", 409);

        if (current.basis === "Ja" || current.basis === "Nei")
          return yield* refuse("admission-outcome.derived", 422);

        if (current.basis === "Unreviewed")
          return yield* refuse("admission-outcome.unreviewed", 422);

        if (current.outcome === command.outcome) return current;

        if (command.outcome === "Rejected" && current.placed)
          return yield* refuse("admission-outcome.placement-active", 409);

        return yield* run(
          appendRevision(applicationId, command.outcome, actor, now).pipe(
            Effect.andThen(readEntry(applicationId)),
          ),
        );
      }),
    announceAdmissionOutcome: ({ applicationId, actor, now }, checkPrecondition, render) =>
      Effect.gen(function* () {
        yield* run(lockOutcomeScope(applicationId));
        const current = yield* run(readEntry(applicationId));
        yield* checkPrecondition(current);

        if (current.state === "OutcomeAnnounced")
          return yield* refuse("admission-outcome.final", 409);

        const outcome = current.outcome;

        if (outcome === null)
          return yield* refuse(
            current.basis === "Unreviewed"
              ? "admission-outcome.unreviewed"
              : "admission-outcome.undecided",
            current.basis === "Unreviewed" ? 422 : 409,
          );

        if (outcome === "Rejected" && current.placed)
          return yield* refuse("admission-outcome.placement-active", 409);

        const schoolName =
          outcome === "Admitted" && current.placed
            ? (yield* run(findPlacementSchoolName(applicationId))).schoolName
            : null;

        yield* run(
          Effect.gen(function* () {
            // An interview derives Ja and Nei: the derived outcome becomes the final revision
            // unless the latest one already says it. It has no human decider.
            const latest = yield* findLatestRevision(applicationId);

            const finalRevision =
              Option.isSome(latest) && latest.value.outcome === outcome
                ? latest.value.revision
                : yield* appendRevision(applicationId, outcome, null, now);

            yield* Database.use(
              (sql) => sql`INSERT INTO public.admission_outcome_announcements
              (application_id, outcome, outcome_revision, announced_by_person_id, announced_at)
              VALUES (${applicationId}, ${outcome}, ${finalRevision}, ${actor}, ${now})`,
            );
          }),
        );

        yield* queueAnnouncementMail(
          database,
          { applicationId, outcome, schoolName: schoolName ?? undefined },
          render,
        );

        return yield* run(readEntry(applicationId));
      }),
  };
};
