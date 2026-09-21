import { Effect, Schema } from "effect";
import { Database } from "../service.js";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import {
  CreateSocialEventCommand,
  SocialEventListResource,
  SocialEventObservedAt,
  SocialEventResource,
  SocialEventScope,
  SocialEventScopeResource,
  type CreateSocialEventCommand as CreateSocialEventCommandValue,
  type SocialEventListResource as SocialEventListResourceValue,
  type SocialEventObservedAt as SocialEventObservedAtValue,
  type SocialEventResource as SocialEventResourceValue,
  type SocialEventScope as SocialEventScopeValue,
  type SocialEventScopeResource as SocialEventScopeResourceValue,
} from "@vektorprogrammet/domain/social-events";
import {
  SocialEventDecodeError,
  SocialEventPersistenceError,
  SocialEventScopeInvalid,
  type SocialEventFailure,
} from "@vektorprogrammet/domain/social-events";
import type { ReadSocialEventListInput, ReadSocialEventScopeInput } from "@vektorprogrammet/domain/social-events";

interface SnapshotRow {
  readonly observedAt: string;
}

interface DepartmentRow {
  readonly departmentId: string;
  readonly name: string;
}

interface SemesterRow {
  readonly semesterId: string;
  readonly startAt: string;
  readonly endAt: string;
}

interface ScopeExistsRow {
  readonly exists: boolean;
}

interface SocialEventRow {
  readonly eventId: string;
  readonly revision: number;
  readonly departmentId: string;
  readonly semesterId: string;
  readonly audience: string;
  readonly title: string;
  readonly description: string;
  readonly link: string | null;
  readonly startAt: string;
  readonly endAt: string;
}

const decodeError = (operation: string, cause: unknown): SocialEventDecodeError =>
  new SocialEventDecodeError({ operation, message: String(cause) });
const persistenceError = (operation: string, cause: unknown): SocialEventPersistenceError =>
  new SocialEventPersistenceError({ operation, message: String(cause) });

const decodeSnapshotInstant = (value: unknown, operation: string) =>
  Schema.decodeUnknownEffect(SocialEventObservedAt)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError((cause) => decodeError(operation, cause)),
  );
const decodeScope = (value: unknown, operation: string) =>
  Schema.decodeUnknownEffect(SocialEventScope)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError((cause) => decodeError(operation, cause)),
  );
const decodeResource = (value: unknown, operation: string) =>
  Schema.decodeUnknownEffect(SocialEventResource)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError((cause) => decodeError(operation, cause)),
  );
const decodeScopeResource = (value: unknown, operation: string) =>
  Schema.decodeUnknownEffect(SocialEventScopeResource)(value, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError((cause) => decodeError(operation, cause)));
const decodeListResource = (value: unknown, operation: string) =>
  Schema.decodeUnknownEffect(SocialEventListResource)(value, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError((cause) => decodeError(operation, cause)));
const decodeCreateCommand = (value: unknown) =>
  Schema.decodeUnknownEffect(CreateSocialEventCommand)(value, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError((cause) => decodeError("decode social-event create command", cause)));

/**
 * Reads the instant at which PostgreSQL establishes this transaction's first
 * snapshot. Call this before any other snapshot-dependent query and reuse its
 * result for authority and the returned `observedAt` value.
 */
export const readSocialEventSnapshotInstantPostgres = (): Effect.Effect<
  SocialEventObservedAtValue,
  SocialEventDecodeError | SocialEventPersistenceError,
  Database
> =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const rows = yield* sql<SnapshotRow>`
        SELECT to_char(
          statement_timestamp() AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "observedAt"
      `;
      const row = rows[0];
      if (row === undefined) {
        return yield* Effect.fail(
          persistenceError("read social-event snapshot instant", "no row returned"),
        );
      }
      return yield* decodeSnapshotInstant(row.observedAt, "decode social-event snapshot instant");
    }).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read social-event snapshot instant", cause)),
      ),
    ),
  );

const observedAtForRead = (provided: SocialEventObservedAtValue | undefined) =>
  provided === undefined ? readSocialEventSnapshotInstantPostgres() : Effect.succeed(provided);

/**
 * Reads canonical semesters and exactly the departments visible through the
 * authority projection supplied by the handler's transaction.
 */
export const readSocialEventScopePostgres = (
  input: ReadSocialEventScopeInput,
): Effect.Effect<SocialEventScopeResourceValue, SocialEventFailure, Database> =>
  Effect.gen(function* () {
    const observedAt = yield* observedAtForRead(input.observedAt);
    if (input.authority.evaluatedAt !== observedAt) {
      return yield* Effect.fail(
        decodeError(
          "read social-event scope",
          "Organization authority and social-event snapshot instants differ",
        ),
      );
    }
    const sql = yield* Database;
    const departments = yield* sql<DepartmentRow>`
      SELECT department_id AS "departmentId", name
      FROM public.organization_departments
      ORDER BY name ASC, department_id ASC
    `;
    const activeDepartmentIds = new Set(
      input.authority.memberships
        .filter((membership) => membership.active)
        .map((membership) => String(membership.departmentId)),
    );
    const visibleDepartments =
      input.authority.globalAdministrator === "Active"
        ? departments
        : departments.filter((department) => activeDepartmentIds.has(department.departmentId));
    const semesters = yield* sql<SemesterRow>`
      SELECT
        semester_id AS "semesterId",
        to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
        to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endAt"
      FROM public.admission_period_semesters
      ORDER BY start_at DESC, semester_id ASC
    `;
    return yield* decodeScopeResource(
      { observedAt, departments: visibleDepartments, semesters },
      "decode social-event scope",
    );
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read social-event scope", cause)),
    ),
  );

/** Validates both selected canonical owner rows without widening authority. */
export const validateSocialEventScopePostgres = (
  input: SocialEventScopeValue,
): Effect.Effect<SocialEventScopeValue, SocialEventFailure, Database> =>
  Effect.gen(function* () {
    const scope = yield* decodeScope(input, "decode social-event scope");
    const sql = yield* Database;
    const departmentRows = yield* sql<ScopeExistsRow>`
      SELECT EXISTS (
        SELECT 1
        FROM public.organization_departments
        WHERE department_id = ${scope.departmentId}
      ) AS "exists"
    `;
    const semesterRows = yield* sql<ScopeExistsRow>`
      SELECT EXISTS (
        SELECT 1
        FROM public.admission_period_semesters
        WHERE semester_id = ${scope.semesterId}
      ) AS "exists"
    `;
    if (departmentRows[0]?.exists !== true || semesterRows[0]?.exists !== true) {
      return yield* Effect.fail(
        new SocialEventScopeInvalid({
          departmentId: String(scope.departmentId),
          semesterId: String(scope.semesterId),
        }),
      );
    }
    return scope;
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("validate social-event scope", cause)),
    ),
  );

/** Reads one validated scope in canonical start-time, event-identity order. */
export const readSocialEventListPostgres = (
  input: ReadSocialEventListInput,
): Effect.Effect<SocialEventListResourceValue, SocialEventFailure, Database> =>
  Effect.gen(function* () {
    const observedAt = yield* observedAtForRead(input.observedAt);
    const scope = yield* validateSocialEventScopePostgres({
      departmentId: input.departmentId,
      semesterId: input.semesterId,
    });
    const sql = yield* Database;
    const rows = yield* sql<SocialEventRow>`
      SELECT
        event_id AS "eventId",
        revision,
        department_id AS "departmentId",
        semester_id AS "semesterId",
        audience,
        title,
        description,
        link,
        to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
        to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endAt"
      FROM public.social_events
      WHERE department_id = ${scope.departmentId}
        AND semester_id = ${scope.semesterId}
      ORDER BY start_at ASC, event_id ASC
    `;
    const events = yield* Effect.forEach(rows, (row) =>
      decodeResource(row, "decode social-event list row"),
    );
    return yield* decodeListResource({ observedAt, ...scope, events }, "decode social-event list");
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read social-event list", cause)),
    ),
  );

/**
 * Inserts the canonical event, one domain command receipt, and one audit row.
 * The caller owns the serializable HTTP transaction and has already performed
 * authority plus selected-scope validation before the generic receipt lookup.
 */
export const createSocialEventPostgres = (
  input: CreateSocialEventCommandValue,
): Effect.Effect<SocialEventResourceValue, SocialEventFailure, Database> =>
  Effect.gen(function* () {
    const command = yield* decodeCreateCommand(input);
    const scope = yield* validateSocialEventScopePostgres({
      departmentId: command.request.departmentId,
      semesterId: command.request.semesterId,
    });
    const sql = yield* Database;
    const rows = yield* sql<SocialEventRow>`
      INSERT INTO public.social_events (
        event_id,
        department_id,
        semester_id,
        audience,
        title,
        description,
        link,
        start_at,
        end_at,
        revision,
        created_command_id
      ) VALUES (
        ${command.eventId},
        ${scope.departmentId},
        ${scope.semesterId},
        ${command.request.audience},
        ${command.request.title},
        ${command.request.description},
        ${command.request.link},
        ${command.request.startAt},
        ${command.request.endAt},
        0,
        ${command.commandId}
      )
      RETURNING
        event_id AS "eventId",
        revision,
        department_id AS "departmentId",
        semester_id AS "semesterId",
        audience,
        title,
        description,
        link,
        to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
        to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endAt"
    `;
    const row = rows[0];
    if (row === undefined) {
      return yield* Effect.fail(
        persistenceError("insert social-event", "insert did not return an event"),
      );
    }
    const resource = yield* decodeResource(row, "decode created social-event");
    const receiptCommand = {
      _tag: "CreateSocialEvent" as const,
      commandId: command.commandId,
      eventId: command.eventId,
      actorPersonId: command.actorPersonId,
      occurredAt: command.occurredAt,
      ...command.request,
    };
    const commandSha256 = sha256Hex(canonicalJsonBytes(receiptCommand));
    yield* sql`
      INSERT INTO public.social_event_command_receipts (
        command_id,
        command_sha256,
        command_json,
        observation_json,
        event_id,
        actor_person_id,
        committed_at
      ) VALUES (
        ${command.commandId},
        ${commandSha256},
        ${sql.json(receiptCommand)},
        ${sql.json(resource)},
        ${resource.eventId},
        ${command.actorPersonId},
        ${command.occurredAt}
      )
    `;
    yield* sql`
      INSERT INTO public.social_event_audit (
        command_id,
        event_id,
        actor_person_id,
        action,
        occurred_at
      ) VALUES (
        ${command.commandId},
        ${resource.eventId},
        ${command.actorPersonId},
        'SocialEventCreated',
        ${command.occurredAt}
      )
    `;
    return resource;
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("create social-event", cause)),
    ),
  );
