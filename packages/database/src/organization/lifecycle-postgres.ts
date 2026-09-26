import { flow, Predicate, DateTime, Effect, Schema } from "effect";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/shared-kernel";
import {
  reaches,
  reachScopes,
  ReachScope,
  ReachTarget,
  scopeCovers,
} from "@vektorprogrammet/domain/authz";
import {
  Appointment,
  AppointmentManagement,
  DepartmentId,
  DepartmentRecognition,
  OrganizationLifecycleCommand,
  OrganizationLifecycleFailure,
  transitionAppointment,
  transitionDepartmentRecognition,
  transitionTeamClassification,
  appointmentStateAt,
  OrganizationLifecycleResult,
  PersonId,
  TeamClassification,
  TeamId,
  type OrganizationPersonAuthority,
} from "@vektorprogrammet/domain/organization";
import { AdvisoryLockKey, lockAdvisory } from "../advisory-lock.js";
import { Database, type DatabaseOperations } from "../service.js";
import type { AccountAccess } from "@vektorprogrammet/domain/identity";
import { accountAccessEnabled, changeNativeAccountAccess } from "../identity-access.js";
import {
  lockPersonAuthorization,
  resolveOrganizationPersonAuthorityWithSql,
  lockOrganizationAdministratorSet,
} from "./authority-postgres.js";

const fail = (code: OrganizationLifecycleFailure["code"]) =>
  new OrganizationLifecycleFailure({ code });

const decode = <S extends Schema.Top>(schema: S) =>
  flow(
    Schema.decodeUnknownEffect(schema),
    Effect.mapError(() => fail("Invalid")),
  );

const authorityFor = Effect.fn("organization.lifecycleAuthority")(function* (
  sql: DatabaseOperations,
  personId: PersonId,
  now: string,
) {
  if (!(yield* accountAccessEnabled(sql, personId, "ForShare"))) return yield* fail("Denied");

  const authority = yield* resolveOrganizationPersonAuthorityWithSql(
    sql,
    personId,
    now,
    "ForShare",
  );

  if (reachScopes(authority, "appointments.manage").length === 0) return yield* fail("Denied");

  return authority;
});

interface Unit {
  readonly kind: "Team" | "NationalBoard";
  readonly id: string;
  readonly name: string;
  readonly departmentId: string | null;
}

const unitsFor = (sql: DatabaseOperations) => sql<Unit>`
  SELECT 'Team'::text AS kind, t.team_id AS id, t.name, t.department_id AS "departmentId"
  FROM organization_teams t JOIN organization_departments d ON d.department_id=t.department_id WHERE t.active AND d.active
  UNION ALL SELECT 'NationalBoard', board_id, name, NULL FROM organization_national_boards ORDER BY name,id`;

/** A team or department board sits inside its home department; the national board nowhere. */
const unitTarget = (unit: Pick<Unit, "kind" | "id" | "departmentId">): ReachTarget =>
  unit.kind === "Team" && unit.departmentId !== null
    ? ReachTarget.Team({
        teamId: TeamId.make(unit.id),
        departmentId: DepartmentId.make(unit.departmentId),
      })
    : ReachTarget.NationalBoard();

const allowedUnit = (authority: OrganizationPersonAuthority, unit: Unit) =>
  reaches(authority, "appointments.manage", unitTarget(unit));

const governs = (authority: OrganizationPersonAuthority) =>
  reaches(authority, "organization.govern", ReachTarget.Organization());

const appointmentsFor = (sql: DatabaseOperations, now: string) =>
  sql<Omit<Appointment, "state">>`SELECT
  membership_id AS "appointmentId", person_id AS "personId",
  jsonb_build_object('kind',CASE WHEN board_id IS NULL THEN 'Team' ELSE 'NationalBoard' END,'id',COALESCE(team_id,board_id)) AS target,
  position_name AS position, is_team_leader AS leadership,
  to_char(start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
  CASE WHEN end_at IS NULL THEN NULL ELSE to_char(end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "endAt",
  is_suspended AS suspended, revision
  FROM organization_memberships WHERE team_id IS NOT NULL OR board_id IS NOT NULL ORDER BY start_at,membership_id`.pipe(
    Effect.map((rows) => rows.map((row) => ({ ...row, state: appointmentStateAt(row, now) }))),
  );

/**
 * The people a manager can appoint: everyone for a manager whose reach includes the whole
 * organization; otherwise the people with a membership in a team of a department where the
 * manager holds `appointments.manage`, including a team leader's home department.
 */
const canonicalPeople = (
  sql: DatabaseOperations,
  authority: OrganizationPersonAuthority,
  units: ReadonlyArray<Unit>,
) => {
  const scopes = reachScopes(authority, "appointments.manage");
  const everyone = scopes.some(ReachScope.$is("Organization"));

  const departments = [
    ...new Set(
      units.flatMap((unit) =>
        unit.departmentId !== null && scopes.some((scope) => scopeCovers(scope, unitTarget(unit)))
          ? [unit.departmentId]
          : [],
      ),
    ),
  ];

  return sql<{
    personId: PersonId;
    name: string;
  }>`SELECT p.person_id AS "personId", p.first_name || ' ' || p.last_name AS name
    FROM person_profiles p WHERE ${everyone} OR EXISTS(
      SELECT 1 FROM organization_memberships m JOIN organization_teams t ON t.team_id=m.team_id
      WHERE m.person_id=p.person_id AND ${sql.in("t.department_id", departments)}
    ) ORDER BY p.first_name,p.last_name,p.person_id`;
};

const governanceFor = (sql: DatabaseOperations) =>
  Effect.gen(function* () {
    const teams =
      yield* sql`SELECT t.team_id AS "teamId", t.kind AS "unitKind", t.team_scope AS "teamScope",
      t.revision, t.name, t.department_id AS "departmentId"
      FROM organization_teams t JOIN organization_departments d ON d.department_id=t.department_id
      WHERE t.active AND d.active ORDER BY t.department_id, t.name, t.team_id`;

    const departments =
      yield* sql`SELECT department_id AS "departmentId", independent, revision, name
      FROM organization_departments WHERE active ORDER BY name, department_id`;

    return { teams, departments };
  });

const isLifecycleFailure = Schema.is(OrganizationLifecycleFailure);

const failure = (cause: unknown) =>
  isLifecycleFailure(cause)
    ? cause
    : new OrganizationLifecycleFailure({ code: "Unavailable", cause });

export const readAppointmentManagement = Effect.fn("readAppointmentManagement")(function* (
  actorPersonId: PersonId,
) {
  const sql = yield* Database;

  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* lockPersonAuthorization(sql, actorPersonId);
        const now = DateTime.formatIso(yield* DateTime.now);
        const authority = yield* authorityFor(sql, actorPersonId, now);
        const allUnits = yield* unitsFor(sql);
        const units = allUnits.filter((unit) => allowedUnit(authority, unit));

        const visible = (target: Appointment["target"]) =>
          units.some((unit) => unit.kind === target.kind && unit.id === target.id);

        const appointments = (yield* appointmentsFor(sql, now)).filter((appointment) =>
          visible(appointment.target),
        );

        const history =
          yield* sql`SELECT command_id AS "commandId",action,subject_id AS "subjectId",actor_person_id AS "actorPersonId",
      to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",reason,before_json AS before,after_json AS after,
      target_kind AS "targetKind",target_id AS "targetId" FROM organization_lifecycle_history ORDER BY occurred_at,command_id`;

        const accounts =
          authority.globalAdministrator === "Active"
            ? yield* sql`SELECT id AS "personId",access_disabled AS disabled,access_revision AS revision FROM auth."user" ORDER BY id`
            : [];

        const governor = governs(authority);

        return yield* decode(AppointmentManagement)({
          globalAdministrator: authority.globalAdministrator === "Active",
          people: yield* canonicalPeople(sql, authority, allUnits),
          units: units.map(({ kind, id, ...unit }) => ({ ...unit, target: { kind, id } })),
          appointments,
          accounts,
          history: history
            .filter(
              (row) =>
                authority.globalAdministrator === "Active" ||
                (governor && row.targetKind === "Department") ||
                units.some((unit) => unit.kind === row.targetKind && unit.id === row.targetId),
            )
            .map(({ targetKind: _kind, targetId: _id, ...row }) => row),
          governance: governor ? yield* governanceFor(sql) : null,
        });
      }),
    )
    .pipe(Effect.mapError(failure));
});

/** The facts that the lifecycle history records before and after a command. */
type HistoryFact = Appointment | AccountAccess | TeamClassification | DepartmentRecognition;

type GovernanceCommand = Extract<
  OrganizationLifecycleCommand,
  { readonly _tag: "ClassifyTeam" | "RecogniseDepartment" }
>;

/** Reclassifies a team or changes a department's independence under its row lock. */
const executeGovernance = (sql: DatabaseOperations, command: GovernanceCommand) =>
  Effect.gen(function* () {
    if (Predicate.isTagged(command, "ClassifyTeam")) {
      const current = (yield* sql<{
        readonly teamId: string;
        readonly unitKind: string;
        readonly teamScope: string;
        readonly revision: number;
        readonly departmentId: string;
      }>`SELECT team_id AS "teamId", kind AS "unitKind", team_scope AS "teamScope", revision,
        department_id AS "departmentId"
        FROM organization_teams WHERE team_id=${command.teamId} FOR UPDATE`)[0];

      if (current === undefined) return yield* fail("NotFound");

      const { departmentId, ...classification } = current;
      const before = yield* decode(TeamClassification)(classification);

      const otherBoards =
        yield* sql`SELECT team_id FROM organization_teams WHERE department_id=${departmentId}
          AND kind='DepartmentBoard' AND team_id<>${command.teamId} FOR SHARE`;

      const after = yield* Effect.fromResult(
        transitionTeamClassification(before, command, otherBoards.length > 0),
      ).pipe(Effect.mapError((error) => fail(error.code)));

      const changed =
        yield* sql`UPDATE organization_teams SET kind=${after.unitKind}, team_scope=${after.teamScope},
        revision=revision+1 WHERE team_id=${command.teamId} AND revision=${before.revision} RETURNING team_id`;

      if (changed.length !== 1) return yield* fail("Stale");

      return {
        target: { kind: "Team", id: command.teamId },
        subjectId: command.teamId,
        before,
        after,
      };
    }

    const current = (yield* sql`SELECT department_id AS "departmentId", independent, revision
      FROM organization_departments WHERE department_id=${command.departmentId} FOR UPDATE`)[0];

    if (current === undefined) return yield* fail("NotFound");

    const before = yield* decode(DepartmentRecognition)(current);

    const after = yield* Effect.fromResult(transitionDepartmentRecognition(before, command)).pipe(
      Effect.mapError((error) => fail(error.code)),
    );

    const changed = yield* sql`UPDATE organization_departments SET independent=${after.independent},
      revision=revision+1 WHERE department_id=${command.departmentId} AND revision=${before.revision}
      RETURNING department_id`;

    if (changed.length !== 1) return yield* fail("Stale");

    return {
      target: { kind: "Department", id: command.departmentId },
      subjectId: command.departmentId,
      before,
      after,
    };
  });

/** Both direct service callers and HTTP replays pass through current authority first. */
export const executeOrganizationLifecycle = Effect.fn("executeOrganizationLifecycle")(function* (
  unsafeCommand: OrganizationLifecycleCommand,
  actorPersonId: PersonId,
) {
  const command = yield* decode(OrganizationLifecycleCommand)(unsafeCommand);
  const sql = yield* Database;

  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* lockAdvisory(sql, AdvisoryLockKey.organizationLifecycleCommand(command.commandId));

        if (Predicate.isTagged(command, "ChangeAccountAccess"))
          yield* lockOrganizationAdministratorSet(sql);

        const observed =
          "appointmentId" in command
            ? (yield* sql<{
                personId: PersonId;
              }>`SELECT person_id AS "personId" FROM organization_memberships WHERE membership_id=${command.appointmentId}`)[0]
            : undefined;

        const subject = "personId" in command ? command.personId : observed?.personId;

        for (const id of [...new Set([actorPersonId, ...(subject ? [subject] : [])])].sort())
          yield* lockPersonAuthorization(sql, id);
        const now = DateTime.formatIso(yield* DateTime.now);
        const authority = yield* authorityFor(sql, actorPersonId, now);

        const current =
          "appointmentId" in command
            ? (yield* appointmentsFor(sql, now)).find(
                (row) => row.appointmentId === command.appointmentId,
              )
            : undefined;

        if ("appointmentId" in command && (!current || current.personId !== observed?.personId))
          return yield* fail("NotFound");
        const target = Predicate.isTagged(command, "Appoint") ? command.target : current?.target;
        const units = yield* unitsFor(sql);

        if (target) {
          const unit = units.find((unit) => unit.kind === target.kind && unit.id === target.id);

          if (!unit) return yield* fail("NotFound");

          if (!allowedUnit(authority, unit)) return yield* fail("Denied");
        } else if (
          Predicate.isTagged(command, "ClassifyTeam") ||
          Predicate.isTagged(command, "RecogniseDepartment")
        ) {
          if (!governs(authority)) return yield* fail("Denied");
        } else if (authority.globalAdministrator !== "Active") return yield* fail("Denied");

        if (
          Predicate.isTagged(command, "Appoint") &&
          !(yield* canonicalPeople(sql, authority, units)).some(
            (person) => person.personId === command.personId,
          )
        )
          return yield* fail("Denied");
        const digest = sha256Hex(canonicalJsonBytes({ actorPersonId, command }));

        const receipt = (yield* sql<{
          digest: string;
          result: unknown;
        }>`SELECT command_digest AS digest,result_json AS result FROM organization_lifecycle_history WHERE command_id=${command.commandId}`)[0];

        if (receipt) {
          if (receipt.digest !== digest) return yield* fail("Conflict");

          return yield* decode(OrganizationLifecycleResult)(receipt.result);
        }

        let before: HistoryFact | null = current ?? null;
        let after: HistoryFact | null = null;
        let historyTarget: { readonly kind: string; readonly id: string } | undefined = target;
        let subjectId: string;
        let revision = 0;

        if (Predicate.isTagged(command, "ChangeAccountAccess")) {
          const changed = yield* changeNativeAccountAccess(sql, command, actorPersonId, now).pipe(
            Effect.catchTag("AccountAccessFailure", (error) => Effect.fail(fail(error.code))),
          );

          before = changed.before;
          after = changed.after;
          subjectId = command.personId;
          revision = after.revision;
        } else if (Predicate.isTagged(command, "CreateNationalBoard")) {
          subjectId =
            "board-" +
            sha256Hex(canonicalJsonBytes({ actorPersonId, commandId: command.commandId }));
          yield* sql`INSERT INTO organization_national_boards(board_id,name) VALUES(${subjectId},${command.name})`;
        } else if (
          Predicate.isTagged(command, "ClassifyTeam") ||
          Predicate.isTagged(command, "RecogniseDepartment")
        ) {
          const governed = yield* executeGovernance(sql, command);

          before = governed.before;
          after = governed.after;
          historyTarget = governed.target;
          subjectId = governed.subjectId;
          revision = governed.after.revision;
        } else {
          subjectId = Predicate.isTagged(command, "Appoint")
            ? "appointment-" +
              sha256Hex(canonicalJsonBytes({ actorPersonId, commandId: command.commandId }))
            : command.appointmentId;

          const next = yield* Effect.fromResult(
            transitionAppointment(current, command, subjectId, now),
          ).pipe(Effect.mapError((error) => fail(error.code)));

          after = yield* decode(Appointment)(next);
          revision = after.revision;

          if (Predicate.isTagged(command, "Appoint")) {
            const person =
              yield* sql`SELECT person_id FROM person_profiles WHERE person_id=${next.personId} FOR KEY SHARE`;

            if (person.length !== 1) return yield* fail("NotFound");
            yield* sql`INSERT INTO organization_memberships(membership_id,person_id,team_id,board_id,position_name,is_team_leader,start_at,end_at,is_suspended,revision)
          VALUES(${subjectId},${next.personId},${next.target.kind === "Team" ? next.target.id : null},${next.target.kind === "NationalBoard" ? next.target.id : null},${next.position},${next.leadership},${next.startAt},${next.endAt},false,0)`;
          } else {
            const changed =
              yield* sql`UPDATE organization_memberships SET position_name=${next.position},is_team_leader=${next.leadership},start_at=${next.startAt},end_at=${next.endAt},is_suspended=${next.suspended},revision=revision+1
          WHERE membership_id=${subjectId} AND person_id=${current!.personId} AND revision=${current!.revision} RETURNING membership_id`;

            if (changed.length !== 1) return yield* fail("Stale");
          }
        }

        const result = { commandId: command.commandId, subjectId, revision };
        yield* sql`INSERT INTO organization_lifecycle_history(command_id,command_digest,actor_person_id,subject_id,target_kind,target_id,action,reason,occurred_at,before_json,after_json,result_json)
      VALUES(${command.commandId},${digest},${actorPersonId},${subjectId},${historyTarget?.kind ?? null},${historyTarget?.id ?? null},${command._tag},${command.reason},${now},${before === null ? null : sql.json(before)},${after === null ? null : sql.json(after)},${sql.json(result)})`;

        return result;
      }),
    )
    .pipe(Effect.mapError(failure));
});
