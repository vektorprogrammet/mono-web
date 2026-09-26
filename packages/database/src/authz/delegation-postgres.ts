/**
 * The delegation aggregate (AccessControl `Delegations`) in PostgreSQL: issue and end
 * delegations under current `delegations.manage` reach, with state, revision, command receipt
 * and attributable history in one transaction.
 */
import { DateTime, Effect, flow, Predicate, Schema } from "effect";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/shared-kernel";
import {
  Delegation,
  DelegationArea,
  DelegationCommand,
  DelegationId,
  DelegationManagement,
  DelegationResult,
  delegationStateAt,
  reaches,
  reachScopes,
  ReachTarget,
  transitionDelegation,
  type DelegationTeam,
} from "@vektorprogrammet/domain/authz";
import {
  DepartmentId,
  OrganizationLifecycleFailure,
  PersonId,
  TeamId,
  type OrganizationPersonAuthority,
} from "@vektorprogrammet/domain/organization";
import { AdvisoryLockKey, lockAdvisory } from "../advisory-lock.js";
import { accountAccessEnabled } from "../identity-access.js";
import {
  lockPersonAuthorization,
  resolveOrganizationPersonAuthorityWithSql,
} from "../organization/authority-postgres.js";
import { Database, type DatabaseOperations } from "../service.js";

const fail = (code: OrganizationLifecycleFailure["code"]) =>
  new OrganizationLifecycleFailure({ code });

const decode = <S extends Schema.Top>(schema: S) =>
  flow(
    Schema.decodeUnknownEffect(schema),
    Effect.mapError(() => fail("Invalid")),
  );

const isLifecycleFailure = Schema.is(OrganizationLifecycleFailure);

const failure = (cause: unknown) =>
  isLifecycleFailure(cause)
    ? cause
    : new OrganizationLifecycleFailure({ code: "Unavailable", cause });

const DelegationTeamRow = Schema.Struct({
  teamId: TeamId,
  name: Schema.String,
  departmentId: DepartmentId,
  unitKind: Schema.Literals(["Team", "DepartmentBoard"]),
  teamScope: Schema.Literals(["HomeDepartment", "National"]),
  active: Schema.Boolean,
});

type DelegationTeamRow = typeof DelegationTeamRow.Type;

/**
 * The team's area is where its delegations are managed: the home department's board manages a
 * local team; only national authority manages a national team (O1, O2).
 */
const teamArea = (team: DelegationTeam): ReachTarget =>
  team.teamScope === "National"
    ? ReachTarget.Organization()
    : ReachTarget.Department({ departmentId: team.departmentId });

const manages = (authority: OrganizationPersonAuthority, team: DelegationTeam) =>
  reaches(authority, "delegations.manage", teamArea(team));

const teamsFor = (sql: DatabaseOperations, teamId: TeamId | null, lock: boolean) =>
  sql`SELECT t.team_id AS "teamId", t.name, t.department_id AS "departmentId", t.kind AS "unitKind",
      t.team_scope AS "teamScope", (t.active AND d.active) AS active
    FROM organization_teams t JOIN organization_departments d ON d.department_id = t.department_id
    WHERE ${teamId === null ? sql`TRUE` : sql`t.team_id = ${teamId}`}
    ORDER BY t.department_id, t.name, t.team_id
    ${lock ? sql`FOR SHARE OF t, d` : sql``}`.pipe(
    Effect.flatMap(decode(Schema.Array(DelegationTeamRow))),
  );

const delegationColumns = (sql: DatabaseOperations) => sql`
  delegation.delegation_id AS "delegationId", delegation.name, delegation.team_id AS "teamId",
  delegation.capability,
  CASE delegation.area
    WHEN 'Department' THEN jsonb_build_object('_tag', 'Department', 'departmentId', delegation.area_department_id)
    ELSE jsonb_build_object('_tag', 'Organization')
  END AS area,
  delegation.holders,
  to_char(delegation.start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
  CASE WHEN delegation.end_at IS NULL THEN NULL
    ELSE to_char(delegation.end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "endAt",
  delegation.revision`;

const managerAuthority = Effect.fn("Delegations.managerAuthority")(function* (
  sql: DatabaseOperations,
  personId: PersonId,
  now: string,
) {
  if (!(yield* accountAccessEnabled(sql, personId, "ForShare"))) return yield* fail("Denied");

  return yield* resolveOrganizationPersonAuthorityWithSql(sql, personId, now, "ForShare");
});

/** The teams, delegations and history within the person's `delegations.manage` reach. */
export const readDelegationManagement = Effect.fn("readDelegationManagement")(function* (
  actorPersonId: PersonId,
) {
  const sql = yield* Database;

  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* lockPersonAuthorization(sql, actorPersonId);
        const now = DateTime.formatIso(yield* DateTime.now);
        const authority = yield* managerAuthority(sql, actorPersonId, now);

        if (reachScopes(authority, "delegations.manage").length === 0) return yield* fail("Denied");

        const teams = (yield* teamsFor(sql, null, false)).filter(
          (team) => team.active && team.unitKind === "Team" && manages(authority, team),
        );

        const teamIds = teams.map((team) => team.teamId);

        const delegations = yield* sql`SELECT ${delegationColumns(sql)}
          FROM organization_delegations AS delegation
          WHERE ${sql.in("delegation.team_id", teamIds)}
          ORDER BY delegation.start_at DESC, delegation.delegation_id`.pipe(
          Effect.flatMap(decode(Schema.Array(Delegation))),
        );

        const history = yield* sql`SELECT command_id AS "commandId", action,
            delegation_id AS "delegationId", team_id AS "teamId", actor_person_id AS "actorPersonId",
            to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",
            reason, before_json AS before, after_json AS after
          FROM organization_delegation_history
          WHERE ${sql.in("team_id", teamIds)}
          ORDER BY occurred_at, command_id`;

        const departments = yield* sql`SELECT department_id AS "departmentId", name
          FROM organization_departments WHERE active ORDER BY name, department_id`;

        return yield* decode(DelegationManagement)({
          teams: teams.map(({ teamId, name, departmentId, teamScope }) => ({
            teamId,
            name,
            departmentId,
            teamScope,
          })),
          departments,
          delegations: delegations.map((delegation) => ({
            ...delegation,
            state: delegationStateAt(delegation, now),
          })),
          history,
        });
      }),
    )
    .pipe(Effect.mapError(failure));
});

/** Both direct service callers and HTTP replays pass through current authority first. */
export const executeDelegation = Effect.fn("executeDelegation")(function* (
  unsafeCommand: DelegationCommand,
  actorPersonId: PersonId,
) {
  const command = yield* decode(DelegationCommand)(unsafeCommand);
  const sql = yield* Database;

  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* lockAdvisory(sql, AdvisoryLockKey.delegationCommand(command.commandId));
        yield* lockPersonAuthorization(sql, actorPersonId);
        const now = DateTime.formatIso(yield* DateTime.now);
        const authority = yield* managerAuthority(sql, actorPersonId, now);

        const current = Predicate.isTagged(command, "EndDelegation")
          ? (yield* sql`SELECT ${delegationColumns(sql)}
              FROM organization_delegations AS delegation
              WHERE delegation.delegation_id = ${command.delegationId}
              FOR UPDATE`.pipe(Effect.flatMap(decode(Schema.Array(Delegation)))))[0]
          : undefined;

        if (Predicate.isTagged(command, "EndDelegation") && current === undefined)
          return yield* fail("NotFound");

        const teamId = Predicate.isTagged(command, "IssueDelegation")
          ? command.teamId
          : current!.teamId;

        const team = (yield* teamsFor(sql, teamId, true))[0];

        if (team === undefined) return yield* fail("NotFound");

        if (!manages(authority, team)) return yield* fail("Denied");

        const digest = sha256Hex(canonicalJsonBytes({ actorPersonId, command }));

        const receipt = (yield* sql<{
          readonly digest: string;
          readonly result: unknown;
        }>`SELECT command_digest AS digest, result_json AS result
          FROM organization_delegation_history WHERE command_id = ${command.commandId}`)[0];

        if (receipt) {
          if (receipt.digest !== digest) return yield* fail("Conflict");

          return yield* decode(DelegationResult)(receipt.result);
        }

        const delegationId = Predicate.isTagged(command, "IssueDelegation")
          ? DelegationId.make(
              "delegation-" +
                sha256Hex(canonicalJsonBytes({ actorPersonId, commandId: command.commandId })),
            )
          : command.delegationId;

        const next = yield* Effect.fromResult(
          transitionDelegation(current, command, { delegationId, team, now }),
        ).pipe(Effect.mapError((error) => fail(error.code)));

        if (Predicate.isTagged(command, "IssueDelegation")) {
          yield* sql`INSERT INTO organization_delegations(delegation_id, name, team_id, capability, area,
              area_department_id, holders, start_at, end_at, revision)
            VALUES(${next.delegationId}, ${next.name}, ${next.teamId}, ${next.capability}, ${next.area._tag},
              ${DelegationArea.guards.Department(next.area) ? next.area.departmentId : null}, ${next.holders},
              ${next.startAt}, ${next.endAt}, 0)`;
        } else {
          const changed = yield* sql`UPDATE organization_delegations
            SET end_at = ${next.endAt}, revision = revision + 1
            WHERE delegation_id = ${next.delegationId} AND revision = ${current!.revision}
            RETURNING delegation_id`;

          if (changed.length !== 1) return yield* fail("Stale");
        }

        const result = { commandId: command.commandId, delegationId, revision: next.revision };

        yield* sql`INSERT INTO organization_delegation_history(command_id, command_digest, actor_person_id,
            delegation_id, team_id, action, reason, occurred_at, before_json, after_json, result_json)
          VALUES(${command.commandId}, ${digest}, ${actorPersonId}, ${delegationId}, ${next.teamId},
            ${command._tag}, ${command.reason}, ${now}, ${current === undefined ? null : sql.json(current)},
            ${sql.json(next)}, ${sql.json(result)})`;

        return result;
      }),
    )
    .pipe(Effect.mapError(failure));
});
