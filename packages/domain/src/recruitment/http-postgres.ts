import type { Admissions } from "../admissions/service.js";
import { PublicApplicationIdSchema } from "../application/schema.js";
import { Database, type DatabaseShape } from "../database/service.js";
import type { Profile } from "../profile/service.js";
import { DepartmentId, PersonId } from "../organization/schema.js";
import { canonicalJsonBytes, sha256Hex } from "../tutor/evidence.js";
import { Effect, Schema } from "effect";
import {
  RecruitmentApplicationNotFound,
  RecruitmentDecodeError,
  RecruitmentInterviewNotFound,
  RecruitmentInvitationNotFound,
  RecruitmentPersistenceError,
} from "./errors.js";
import {
  confirmInvitation,
  rejectInvitation,
  requestNewInvitationTime,
} from "./invitation-response-postgres.js";
import {
  RecruitmentActorSchema,
  RecruitmentInstantSchema,
  RecruitmentInterviewId,
  RecruitmentInvitationCapabilitySchema,
  RecruitmentInvitationId,
  RecruitmentInvitationResponseStateSchema,
  type RecruitmentActor,
  type RecruitmentInvitationCapability,
  type RecruitmentInvitationResponseMessage,
  type RecruitmentInvitationResponseResult,
} from "./schema.js";

const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

const RecruitmentInvitationHttpSourceSchema = Schema.Struct({
  capabilitySha256: Schema.String,
  invitationId: RecruitmentInvitationId,
  interviewId: RecruitmentInterviewId,
  departmentId: DepartmentId,
  scheduleRevision: Revision,
  responseRevision: Revision,
  responseState: RecruitmentInvitationResponseStateSchema,
  supersededAt: Schema.NullOr(RecruitmentInstantSchema),
});
export type RecruitmentInvitationHttpSource = typeof RecruitmentInvitationHttpSourceSchema.Type;

const RecruitmentApplicationHttpAccessSchema = Schema.Struct({
  applicationId: PublicApplicationIdSchema,
  departmentId: DepartmentId,
  interviewerEligible: Schema.Boolean,
});
export type RecruitmentApplicationHttpAccess = typeof RecruitmentApplicationHttpAccessSchema.Type;

const RecruitmentAuthorityHttpSourceSchema = Schema.Struct({
  kind: Schema.Literals(["GlobalAdministrator", "Membership"]),
  identity: Schema.String,
  revisions: Schema.Array(Revision),
});
export type RecruitmentAuthorityHttpSource = typeof RecruitmentAuthorityHttpSourceSchema.Type;

const RecruitmentInterviewHttpSourceSchema = Schema.Struct({
  interviewId: RecruitmentInterviewId,
  departmentId: DepartmentId,
  interviewerPersonId: PersonId,
  interviewRevision: Revision,
  authority: Schema.Array(RecruitmentAuthorityHttpSourceSchema),
});
export type RecruitmentInterviewHttpSource = typeof RecruitmentInterviewHttpSourceSchema.Type;

const decodeError = (operation: string, cause: unknown) =>
  new RecruitmentDecodeError({ message: `${operation}: ${String(cause)}` });

const persistenceError = (operation: string, cause: unknown) =>
  new RecruitmentPersistenceError({ operation, message: String(cause) });

const capabilityDigest = (capability: RecruitmentInvitationCapability): string =>
  sha256Hex(new TextEncoder().encode(capability));

/** Canonical capability-selected source for invitation access and ETags. */
export const readRecruitmentInvitationHttpSourcePostgres = (
  capabilityInput: RecruitmentInvitationCapability,
): Effect.Effect<
  RecruitmentInvitationHttpSource,
  RecruitmentInvitationNotFound | RecruitmentDecodeError | RecruitmentPersistenceError,
  Database
> =>
  Database.use((database) =>
    Effect.gen(function* () {
      const capability = yield* Schema.decodeUnknownEffect(RecruitmentInvitationCapabilitySchema)(
        capabilityInput,
        { onExcessProperty: "error" },
      ).pipe(Effect.mapError(() => new RecruitmentInvitationNotFound({})));
      const capabilitySha256 = capabilityDigest(capability);
      const rows = yield* database`
        SELECT
          ${capabilitySha256}::text AS "capabilitySha256",
          invitation.invitation_id AS "invitationId",
          invitation.interview_id AS "interviewId",
          interview.department_id AS "departmentId",
          invitation.schedule_revision AS "scheduleRevision",
          invitation.response_revision AS "responseRevision",
          invitation.response_state AS "responseState",
          CASE WHEN invitation.superseded_at IS NULL THEN NULL
            ELSE to_char(
              invitation.superseded_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )
          END AS "supersededAt"
        FROM public.recruitment_invitations AS invitation
        INNER JOIN public.recruitment_interviews AS interview
          ON interview.interview_id = invitation.interview_id
        WHERE invitation.capability_sha256 = ${capabilitySha256}
          AND invitation.superseded_at IS NULL
      `.pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("read recruitment invitation HTTP source", cause)),
        ),
      );
      const row = rows[0];
      if (row === undefined) return yield* new RecruitmentInvitationNotFound({});
      return yield* Schema.decodeUnknownEffect(RecruitmentInvitationHttpSourceSchema)(row, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError((cause) => decodeError("decode recruitment invitation HTTP source", cause)),
      );
    }),
  );

/** Application scope and target-interviewer eligibility for native access evaluation. */
export const readRecruitmentApplicationHttpAccessPostgres = (input: {
  readonly applicationId: typeof PublicApplicationIdSchema.Type;
  readonly interviewerPersonId: PersonId;
  readonly authorizationInstant: string;
}): Effect.Effect<
  RecruitmentApplicationHttpAccess,
  RecruitmentApplicationNotFound | RecruitmentDecodeError | RecruitmentPersistenceError,
  Database
> =>
  Database.use((database) =>
    Effect.gen(function* () {
      const rows = yield* database`
        SELECT
          application.application_id AS "applicationId",
          application.department_id AS "departmentId",
          EXISTS (
            SELECT 1
            FROM public.organization_memberships AS membership
            INNER JOIN public.organization_teams AS team
              ON team.team_id = membership.team_id
            INNER JOIN public.organization_departments AS department
              ON department.department_id = team.department_id
            WHERE membership.person_id = ${input.interviewerPersonId}
              AND team.department_id = application.department_id
              AND membership.start_at <= ${input.authorizationInstant}::timestamptz
              AND (
                membership.end_at IS NULL
                OR ${input.authorizationInstant}::timestamptz < membership.end_at
              )
              AND NOT membership.is_suspended
              AND team.active
              AND department.active
          ) AS "interviewerEligible"
        FROM public.admission_applications AS application
        WHERE application.application_id = ${input.applicationId}
      `.pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("read recruitment application HTTP access", cause)),
        ),
      );
      const row = rows[0];
      if (row === undefined) {
        return yield* new RecruitmentApplicationNotFound({
          applicationId: input.applicationId,
        });
      }
      return yield* Schema.decodeUnknownEffect(RecruitmentApplicationHttpAccessSchema)(row, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError((cause) =>
          decodeError("decode recruitment application HTTP access", cause),
        ),
      );
    }),
  );

const RecruitmentTargetActorSourceSchema = Schema.Struct({
  globalAdministrator: Schema.Boolean,
  activeMember: Schema.Boolean,
  activeLeader: Schema.Boolean,
});

/**
 * Reconstructs the caller's current actor for one canonical target department.
 * This avoids selecting an unrelated first membership for item routes.
 */
export const readRecruitmentTargetActorPostgres = (input: {
  readonly personId: PersonId;
  readonly departmentId: DepartmentId;
  readonly authorizationInstant: string;
}): Effect.Effect<
  RecruitmentActor,
  RecruitmentDecodeError | RecruitmentPersistenceError,
  Database
> =>
  Database.use((database) =>
    Effect.gen(function* () {
      const rows = yield* database`
        SELECT
          EXISTS (
            SELECT 1
            FROM public.organization_global_administrator_grants AS grant
            WHERE grant.person_id = ${input.personId}
              AND grant.start_at <= ${input.authorizationInstant}::timestamptz
              AND (
                grant.end_at IS NULL
                OR ${input.authorizationInstant}::timestamptz < grant.end_at
              )
          ) AS "globalAdministrator",
          EXISTS (
            SELECT 1
            FROM public.organization_memberships AS membership
            INNER JOIN public.organization_teams AS team
              ON team.team_id = membership.team_id
            INNER JOIN public.organization_departments AS department
              ON department.department_id = team.department_id
            WHERE membership.person_id = ${input.personId}
              AND team.department_id = ${input.departmentId}
              AND membership.start_at <= ${input.authorizationInstant}::timestamptz
              AND (
                membership.end_at IS NULL
                OR ${input.authorizationInstant}::timestamptz < membership.end_at
              )
              AND NOT membership.is_suspended
              AND team.active
              AND department.active
          ) AS "activeMember",
          EXISTS (
            SELECT 1
            FROM public.organization_memberships AS membership
            INNER JOIN public.organization_teams AS team
              ON team.team_id = membership.team_id
            INNER JOIN public.organization_departments AS department
              ON department.department_id = team.department_id
            WHERE membership.person_id = ${input.personId}
              AND team.department_id = ${input.departmentId}
              AND membership.start_at <= ${input.authorizationInstant}::timestamptz
              AND (
                membership.end_at IS NULL
                OR ${input.authorizationInstant}::timestamptz < membership.end_at
              )
              AND NOT membership.is_suspended
              AND membership.is_team_leader
              AND team.active
              AND department.active
          ) AS "activeLeader"
      `.pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("read recruitment target actor", cause)),
        ),
      );
      const source = yield* Schema.decodeUnknownEffect(RecruitmentTargetActorSourceSchema)(
        rows[0],
        { onExcessProperty: "error" },
      ).pipe(Effect.mapError((cause) => decodeError("decode recruitment target actor", cause)));
      const actor = source.globalAdministrator
        ? { _tag: "GlobalAdmin" as const, personId: input.personId, active: true }
        : source.activeLeader
          ? {
              _tag: "DepartmentLeader" as const,
              personId: input.personId,
              departmentId: input.departmentId,
              active: true,
            }
          : {
              _tag: "Member" as const,
              personId: input.personId,
              departmentId: input.departmentId,
              active: source.activeMember,
            };
      return yield* Schema.decodeEffect(RecruitmentActorSchema)(actor, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError((cause) => decodeError("decode recruitment target actor", cause)));
    }),
  );

const readRecruitmentPersonAuthorityHttpSources = (
  database: DatabaseShape,
  personId: PersonId,
): Effect.Effect<
  ReadonlyArray<RecruitmentAuthorityHttpSource>,
  RecruitmentDecodeError | RecruitmentPersistenceError
> =>
  Effect.gen(function* () {
    const rows = yield* database`
      SELECT kind, identity, revisions
      FROM (
        SELECT
          0 AS kind_order,
          'GlobalAdministrator' AS kind,
          grant_id AS identity,
          ARRAY[revision]::integer[] AS revisions
        FROM public.organization_global_administrator_grants
        WHERE person_id = ${personId}

        UNION ALL

        SELECT
          1 AS kind_order,
          'Membership' AS kind,
          membership.membership_id AS identity,
          ARRAY[membership.revision, team.revision, department.revision]::integer[] AS revisions
        FROM public.organization_memberships AS membership
        INNER JOIN public.organization_teams AS team
          ON team.team_id = membership.team_id
        INNER JOIN public.organization_departments AS department
          ON department.department_id = team.department_id
        WHERE membership.person_id = ${personId}
      ) AS authority
      ORDER BY kind_order, identity
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read recruitment person authority HTTP sources", cause)),
      ),
    );
    return yield* Schema.decodeUnknownEffect(Schema.Array(RecruitmentAuthorityHttpSourceSchema))(
      rows,
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError((cause) =>
        decodeError("decode recruitment person authority HTTP sources", cause),
      ),
    );
  });

/** Ordered authority sources shared by every interview ETag for one person. */
export const readRecruitmentPersonAuthorityHttpSourcesPostgres = (
  personId: PersonId,
): Effect.Effect<
  ReadonlyArray<RecruitmentAuthorityHttpSource>,
  RecruitmentDecodeError | RecruitmentPersistenceError,
  Database
> => Database.use((database) => readRecruitmentPersonAuthorityHttpSources(database, personId));

/** Interview identity, revision, relationship, and ordered authority sources for HTTP ETags. */
export const readRecruitmentInterviewHttpSourcePostgres = (
  interviewId: RecruitmentInterviewId,
  personId: PersonId,
): Effect.Effect<
  RecruitmentInterviewHttpSource,
  RecruitmentInterviewNotFound | RecruitmentDecodeError | RecruitmentPersistenceError,
  Database
> =>
  Database.use((database) =>
    Effect.gen(function* () {
      const interviewRows = yield* database`
        SELECT
          interview_id AS "interviewId",
          department_id AS "departmentId",
          interviewer_person_id AS "interviewerPersonId",
          revision AS "interviewRevision"
        FROM public.recruitment_interviews
        WHERE interview_id = ${interviewId}
      `.pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("read recruitment interview HTTP source", cause)),
        ),
      );
      const interview = interviewRows[0];
      if (interview === undefined) return yield* new RecruitmentInterviewNotFound({ interviewId });

      const authority = yield* readRecruitmentPersonAuthorityHttpSources(database, personId);
      return yield* Schema.decodeUnknownEffect(RecruitmentInterviewHttpSourceSchema)(
        {
          ...interview,
          authority,
        },
        { onExcessProperty: "error" },
      ).pipe(
        Effect.mapError((cause) => decodeError("decode recruitment interview HTTP source", cause)),
      );
    }),
  );

export type RecruitmentInvitationHttpTransition =
  | { readonly _tag: "Confirm" }
  | { readonly _tag: "Reject"; readonly message?: RecruitmentInvitationResponseMessage }
  | { readonly _tag: "RequestNewTime"; readonly message: RecruitmentInvitationResponseMessage };

/** Runs one capability command and records its internal HTTP command identity in the domain transaction. */
export const executeRecruitmentInvitationHttpTransitionPostgres = (input: {
  readonly commandId: string;
  readonly capability: RecruitmentInvitationCapability;
  readonly transition: RecruitmentInvitationHttpTransition;
  readonly now: string;
}): Effect.Effect<RecruitmentInvitationResponseResult, unknown, Database | Admissions | Profile> =>
  Effect.gen(function* () {
    const before = yield* readRecruitmentInvitationHttpSourcePostgres(input.capability);
    const result = yield* input.transition._tag === "Confirm"
      ? confirmInvitation(input.capability, { now: input.now })
      : input.transition._tag === "Reject"
        ? rejectInvitation(
            input.capability,
            input.transition.message === undefined ? {} : { message: input.transition.message },
            { now: input.now },
          )
        : requestNewInvitationTime(
            input.capability,
            { message: input.transition.message },
            { now: input.now },
          );
    const digest = sha256Hex(
      canonicalJsonBytes({
        commandId: input.commandId,
        capabilitySha256: before.capabilitySha256,
        transition: input.transition,
      }),
    );
    const database = yield* Database;
    yield* database`
      INSERT INTO public.recruitment_invitation_response_command_receipts (
        command_id,
        command_sha256,
        invitation_id,
        resulting_response_revision,
        committed_at
      ) VALUES (
        ${input.commandId},
        ${digest},
        ${before.invitationId},
        ${result.responseRevision},
        ${input.now}
      )
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("write invitation response HTTP command receipt", cause)),
      ),
      Effect.asVoid,
    );
    return result;
  });
