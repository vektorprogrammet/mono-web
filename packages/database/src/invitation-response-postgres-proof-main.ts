import assert from "node:assert/strict";
import { AdmissionsLive } from "@vektorprogrammet/domain/admissions";
import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import {
  NotificationGateway,
  makeRecordingNotificationGateway,
} from "@vektorprogrammet/domain/notification";
import { OrganizationLive } from "@vektorprogrammet/domain/organization";
import { ProfileLive } from "@vektorprogrammet/domain/profile";
import {
  Recruitment,
  RecruitmentInvitationCapabilitySchema,
  RecruitmentLive,
  RecruitmentNotificationDeliveryError,
  deliverNextRecruitmentInvitationResponse,
} from "@vektorprogrammet/domain/recruitment";
import { Config, Deferred, Effect, Fiber, Layer, Redacted } from "effect";
import { DatabaseLive } from "./layers.js";

const cohort = {
  id: "recruitment-invitation-response-postgres-proof-0051-v1",
  departmentId: "invitation-response-pg-proof-department",
  semesterId: "invitation-response-pg-proof-semester",
  admissionPeriodId: "invitation-response-pg-proof-period",
  fieldOfStudyId: "invitation-response-pg-proof-field",
  applicantRaceId: "invitation-response-pg-proof-applicant-race",
  applicantDeliveryId: "invitation-response-pg-proof-applicant-delivery",
  applicationRaceId: "invitation-response-pg-proof-application-race",
  applicationDeliveryId: "invitation-response-pg-proof-application-delivery",
  leaderPersonId: "invitation-response-pg-proof-leader",
  interviewerPersonId: "invitation-response-pg-proof-interviewer",
  interviewSchemaId: "invitation-response-pg-proof-schema",
  raceInterviewId: "inv-response-pg-proof-interview-race",
  deliveryInterviewId: "inv-response-pg-proof-interview-delivery",
  raceInvitationId: "inv-response-pg-proof-invitation-race",
  deliveryInvitationId: "inv-response-pg-proof-invitation-delivery",
} as const;

const raceCapability = "R".repeat(43);
const deliveryCapability = "D".repeat(43);
const responseInstant = "2035-09-15T12:03:00.000Z";
const capabilityShapedMessage = "C".repeat(43);
const validNearbyMessage = "V".repeat(42);

const makeProofLayer = (url: Redacted.Redacted<string>, applicationName: string) => {
  const databaseLayer = DatabaseLive({
    url: Redacted.make(Redacted.value(url)),
    applicationName,
    maxConnections: 1,
  });
  const admissionsLayer = AdmissionsLive.pipe(Layer.provide(databaseLayer));
  const organizationLayer = OrganizationLive.pipe(Layer.provide(databaseLayer));
  const profileLayer = ProfileLive.pipe(
    Layer.provide(Layer.merge(databaseLayer, organizationLayer)),
  );
  const supportLayer = Layer.mergeAll(
    databaseLayer,
    admissionsLayer,
    organizationLayer,
    profileLayer,
  );
  return Layer.merge(supportLayer, RecruitmentLive.pipe(Layer.provide(supportLayer)));
};

const resetCohort = (sql: DatabaseShape) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        DELETE FROM recruitment_invitation_response_outbox
        WHERE invitation_id IN (${cohort.raceInvitationId}, ${cohort.deliveryInvitationId})
      `;
      yield* sql`
        DELETE FROM recruitment_invitation_response_audit
        WHERE invitation_id IN (${cohort.raceInvitationId}, ${cohort.deliveryInvitationId})
      `;
      yield* sql`
        DELETE FROM recruitment_invitations
        WHERE invitation_id IN (${cohort.raceInvitationId}, ${cohort.deliveryInvitationId})
      `;
      yield* sql`
        DELETE FROM recruitment_interview_schedules
        WHERE interview_id IN (${cohort.raceInterviewId}, ${cohort.deliveryInterviewId})
      `;
      yield* sql`
        DELETE FROM recruitment_interviews
        WHERE interview_id IN (${cohort.raceInterviewId}, ${cohort.deliveryInterviewId})
      `;
      yield* sql`
        DELETE FROM recruitment_interview_schemas
        WHERE interview_schema_id = ${cohort.interviewSchemaId}
      `;
      yield* sql`
        DELETE FROM person_contact_profiles
        WHERE person_id IN (${cohort.leaderPersonId}, ${cohort.interviewerPersonId})
      `;
      yield* sql`
        DELETE FROM person_profiles
        WHERE person_id IN (${cohort.leaderPersonId}, ${cohort.interviewerPersonId})
      `;
      yield* sql`
        DELETE FROM admission_applications
        WHERE application_id IN (${cohort.applicationRaceId}, ${cohort.applicationDeliveryId})
      `;
      yield* sql`
        DELETE FROM admission_applicants
        WHERE applicant_id IN (${cohort.applicantRaceId}, ${cohort.applicantDeliveryId})
      `;
      yield* sql`
        DELETE FROM admission_periods
        WHERE admission_period_id = ${cohort.admissionPeriodId}
      `;
      yield* sql`
        DELETE FROM admission_period_fields_of_study
        WHERE field_of_study_id = ${cohort.fieldOfStudyId}
      `;
      yield* sql`
        DELETE FROM admission_period_semesters
        WHERE semester_id = ${cohort.semesterId}
      `;
      yield* sql`
        DELETE FROM admission_period_departments
        WHERE department_id = ${cohort.departmentId}
      `;
    }),
  );

const seedCohort = (sql: DatabaseShape) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO admission_period_departments (department_id, name)
        VALUES (${cohort.departmentId}, 'Invitation response PostgreSQL proof')
      `;
      yield* sql`
        INSERT INTO admission_period_semesters (semester_id, start_at, end_at)
        VALUES (${cohort.semesterId}, '2035-08-01T00:00:00.000Z', '2036-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO admission_periods (
          admission_period_id,
          department_id,
          semester_id,
          start_at,
          end_at,
          last_command_id
        ) VALUES (
          ${cohort.admissionPeriodId},
          ${cohort.departmentId},
          ${cohort.semesterId},
          '2035-09-01T00:00:00.000Z',
          '2035-10-01T00:00:00.000Z',
          'invitation-response-pg-proof-period-created'
        )
      `;
      yield* sql`
        INSERT INTO admission_period_fields_of_study (field_of_study_id, department_id, name)
        VALUES (${cohort.fieldOfStudyId}, ${cohort.departmentId}, 'Computer Science')
      `;
      yield* sql`
        INSERT INTO admission_applicants (
          applicant_id,
          normalized_email,
          email,
          first_name,
          last_name,
          phone,
          gender,
          field_of_study_id,
          year_of_study
        ) VALUES
          (
            ${cohort.applicantRaceId},
            'invitation-response-race@example.invalid',
            'invitation-response-race@example.invalid',
            'Ada',
            'Race',
            '90000001',
            1,
            ${cohort.fieldOfStudyId},
            2
          ),
          (
            ${cohort.applicantDeliveryId},
            'invitation-response-delivery@example.invalid',
            'invitation-response-delivery@example.invalid',
            'Bjarne',
            'Delivery',
            '90000002',
            1,
            ${cohort.fieldOfStudyId},
            2
          )
      `;
      yield* sql`
        INSERT INTO admission_applications (
          application_id,
          applicant_id,
          admission_period_id,
          department_id,
          field_of_study_id,
          year_of_study,
          submitted_at
        ) VALUES
          (
            ${cohort.applicationRaceId},
            ${cohort.applicantRaceId},
            ${cohort.admissionPeriodId},
            ${cohort.departmentId},
            ${cohort.fieldOfStudyId},
            2,
            '2035-09-10T12:00:00.000Z'
          ),
          (
            ${cohort.applicationDeliveryId},
            ${cohort.applicantDeliveryId},
            ${cohort.admissionPeriodId},
            ${cohort.departmentId},
            ${cohort.fieldOfStudyId},
            2,
            '2035-09-10T12:01:00.000Z'
          )
      `;
      yield* sql`
        INSERT INTO person_profiles (person_id, first_name, last_name)
        VALUES
          (${cohort.leaderPersonId}, 'Lise', 'Leader'),
          (${cohort.interviewerPersonId}, 'Ivar', 'Interviewer')
      `;
      yield* sql`
        INSERT INTO person_contact_profiles (person_id, email, phone)
        VALUES
          (${cohort.leaderPersonId}, 'leader.response-proof@example.invalid', '91000001'),
          (${cohort.interviewerPersonId}, 'interviewer.response-proof@example.invalid', '91000002')
      `;
      yield* sql`
        INSERT INTO recruitment_interview_schemas (interview_schema_id, name, question_count)
        VALUES (${cohort.interviewSchemaId}, 'Invitation response proof interview', 8)
      `;
      yield* sql`
        INSERT INTO recruitment_interviews (
          interview_id,
          application_id,
          department_id,
          interviewer_person_id,
          interview_schema_id,
          assigned_by_person_id,
          assigned_at,
          revision
        ) VALUES
          (
            ${cohort.raceInterviewId},
            ${cohort.applicationRaceId},
            ${cohort.departmentId},
            ${cohort.interviewerPersonId},
            ${cohort.interviewSchemaId},
            ${cohort.leaderPersonId},
            '2035-09-15T11:00:00.000Z',
            1
          ),
          (
            ${cohort.deliveryInterviewId},
            ${cohort.applicationDeliveryId},
            ${cohort.departmentId},
            ${cohort.interviewerPersonId},
            ${cohort.interviewSchemaId},
            ${cohort.leaderPersonId},
            '2035-09-15T11:01:00.000Z',
            1
          )
      `;
      yield* sql`
        INSERT INTO recruitment_interview_schedules (
          interview_id,
          scheduled_at,
          room,
          campus,
          map_link,
          message,
          scheduled_by_person_id,
          committed_at,
          schedule_revision
        ) VALUES
          (
            ${cohort.raceInterviewId},
            '2035-09-20T09:00:00.000Z',
            'Proof Room A',
            'Bergen',
            NULL,
            'Race invitation',
            ${cohort.leaderPersonId},
            '2035-09-15T12:00:00.000Z',
            1
          ),
          (
            ${cohort.deliveryInterviewId},
            '2035-09-20T10:00:00.000Z',
            'Proof Room B',
            'Bergen',
            NULL,
            'Delivery invitation',
            ${cohort.leaderPersonId},
            '2035-09-15T12:00:00.000Z',
            1
          )
      `;
      const raceCapabilitySha256 = sha256Hex(new TextEncoder().encode(raceCapability));
      const deliveryCapabilitySha256 = sha256Hex(new TextEncoder().encode(deliveryCapability));
      yield* sql`
        INSERT INTO recruitment_invitations (
          invitation_id,
          interview_id,
          schedule_revision,
          capability_sha256,
          response_state,
          created_at
        ) VALUES
          (
            ${cohort.raceInvitationId},
            ${cohort.raceInterviewId},
            1,
            ${raceCapabilitySha256},
            'Pending',
            '2035-09-15T12:00:00.000Z'
          ),
          (
            ${cohort.deliveryInvitationId},
            ${cohort.deliveryInterviewId},
            1,
            ${deliveryCapabilitySha256},
            'Pending',
            '2035-09-15T12:00:00.000Z'
          )
      `;
    }),
  );

const contender = (
  action: "confirm" | "reject",
  ready: Deferred.Deferred<void>,
  start: Deferred.Deferred<void>,
) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const recruitment = yield* Recruitment;
    const [connection] = yield* sql<{ readonly pid: number }>`
      SELECT pg_backend_pid() AS pid
    `;
    yield* Deferred.succeed(ready, undefined);
    yield* Deferred.await(start);
    const capability = RecruitmentInvitationCapabilitySchema.make(raceCapability);
    const outcome = yield* Effect.result(
      action === "confirm"
        ? recruitment.confirmInvitation(capability, { now: responseInstant })
        : recruitment.rejectInvitation(
            capability,
            { message: "Cannot attend the proposed time." },
            { now: responseInstant },
          ),
    );
    return { action, pid: connection?.pid ?? -1, outcome };
  });

const proveMessageConfinement = (sql: DatabaseShape) =>
  Effect.gen(function* () {
    const ordinaryMessage = "Cannot attend the proposed time.";
    const embeddedCapabilitySequence = `Do not persist (${capabilityShapedMessage}) here`;
    const outboxEffectId = `recruitment-invitation-response:${cohort.raceInvitationId}:1`;
    const [migration] = yield* sql<{ readonly count: string }>`
      SELECT count(*)::text AS count
      FROM vektorprogrammet_schema_migrations
      WHERE migration_id = 13
    `;
    const before = yield* sql<{
      readonly responseState: string;
      readonly responseMessage: string | null;
      readonly responseRevision: number;
      readonly audits: string;
      readonly outbox: string;
    }>`
      SELECT
        invitation.response_state AS "responseState",
        invitation.response_message AS "responseMessage",
        invitation.response_revision AS "responseRevision",
        (
          SELECT count(*)::text
          FROM recruitment_invitation_response_audit
          WHERE invitation_id = invitation.invitation_id
        ) AS audits,
        (
          SELECT count(*)::text
          FROM recruitment_invitation_response_outbox
          WHERE invitation_id = invitation.invitation_id
        ) AS outbox
      FROM recruitment_invitations AS invitation
      WHERE invitation.invitation_id = ${cohort.raceInvitationId}
    `;
    const stageRejectedInvitation = (message: string) => sql`
      UPDATE recruitment_invitations
      SET response_state = 'Rejected',
        response_message = ${message},
        responded_at = ${responseInstant},
        response_revision = 1
      WHERE invitation_id = ${cohort.raceInvitationId}
    `;
    const insertAudit = (message: string) => sql`
      INSERT INTO recruitment_invitation_response_audit (
        invitation_id,
        interview_id,
        schedule_revision,
        response_revision,
        response_state,
        response_message,
        responded_at
      ) VALUES (
        ${cohort.raceInvitationId},
        ${cohort.raceInterviewId},
        1,
        1,
        'Rejected',
        ${message},
        ${responseInstant}
      )
    `;
    const invitationMessage = yield* Effect.result(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* stageRejectedInvitation(capabilityShapedMessage);
          return yield* Effect.fail("InvitationMessageConfinementMissing");
        }),
      ),
    );
    const auditMessage = yield* Effect.result(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* stageRejectedInvitation(ordinaryMessage);
          yield* insertAudit(embeddedCapabilitySequence);
          return yield* Effect.fail("AuditMessageConfinementMissing");
        }),
      ),
    );
    const outboxMessage = yield* Effect.result(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* stageRejectedInvitation(ordinaryMessage);
          yield* insertAudit(ordinaryMessage);
          yield* sql`
            INSERT INTO recruitment_invitation_response_outbox (
              effect_id,
              effect_type,
              invitation_id,
              interview_id,
              schedule_revision,
              response_revision,
              response_state,
              response_message,
              ordinal,
              payload_json
            ) VALUES (
              ${outboxEffectId},
              'SendInterviewInvitationResponse',
              ${cohort.raceInvitationId},
              ${cohort.raceInterviewId},
              1,
              1,
              'Rejected',
              ${capabilityShapedMessage},
              0,
              '{}'::jsonb
            )
          `;
          return yield* Effect.fail("OutboxMessageConfinementMissing");
        }),
      ),
    );
    const outboxPayload = yield* Effect.result(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* stageRejectedInvitation(ordinaryMessage);
          yield* insertAudit(ordinaryMessage);
          yield* sql`
            INSERT INTO recruitment_invitation_response_outbox (
              effect_id,
              effect_type,
              invitation_id,
              interview_id,
              schedule_revision,
              response_revision,
              response_state,
              response_message,
              ordinal,
              payload_json
            ) VALUES (
              ${outboxEffectId},
              'SendInterviewInvitationResponse',
              ${cohort.raceInvitationId},
              ${cohort.raceInterviewId},
              1,
              1,
              'Rejected',
              ${ordinaryMessage},
              0,
              jsonb_build_object('note', ${embeddedCapabilitySequence})
            )
          `;
          return yield* Effect.fail("OutboxPayloadConfinementMissing");
        }),
      ),
    );
    const after = yield* sql<{
      readonly responseState: string;
      readonly responseMessage: string | null;
      readonly responseRevision: number;
      readonly audits: string;
      readonly outbox: string;
    }>`
      SELECT
        invitation.response_state AS "responseState",
        invitation.response_message AS "responseMessage",
        invitation.response_revision AS "responseRevision",
        (
          SELECT count(*)::text
          FROM recruitment_invitation_response_audit
          WHERE invitation_id = invitation.invitation_id
        ) AS audits,
        (
          SELECT count(*)::text
          FROM recruitment_invitation_response_outbox
          WHERE invitation_id = invitation.invitation_id
        ) AS outbox
      FROM recruitment_invitations AS invitation
      WHERE invitation.invitation_id = ${cohort.raceInvitationId}
    `;
    const constraintRejections = [
      invitationMessage,
      auditMessage,
      outboxMessage,
      outboxPayload,
    ].map(
      (result) =>
        result._tag === "Failure" &&
        typeof result.failure === "object" &&
        result.failure !== null &&
        "_tag" in result.failure &&
        result.failure._tag === "SqlError",
    );
    return {
      migrationReplayed: migration?.count === "1",
      invitationMessageRejected: constraintRejections[0] === true,
      auditMessageRejected: constraintRejections[1] === true,
      outboxMessageRejected: constraintRejections[2] === true,
      outboxPayloadRejected: constraintRejections[3] === true,
      rollbackPreserved: canonicalJson(before) === canonicalJson(after),
    };
  });

const proof = (databaseUrl: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const setupLayer = makeProofLayer(databaseUrl, "recruitment-invitation-response-proof-setup");
    yield* Effect.gen(function* () {
      const sql = yield* Database;
      assert.equal(sql.schemaRevision, "13_native-organization-administration");
      yield* resetCohort(sql);
      yield* sql`
        DELETE FROM vektorprogrammet_schema_migrations
        WHERE migration_id = 13
      `;
      yield* sql.migrate;
      yield* seedCohort(sql);
    }).pipe(Effect.provide(setupLayer));

    const messageConfinement = yield* Effect.gen(function* () {
      const sql = yield* Database;
      return yield* proveMessageConfinement(sql);
    }).pipe(
      Effect.provide(
        makeProofLayer(databaseUrl, "recruitment-invitation-response-proof-confinement"),
      ),
    );

    const rollbackResult = yield* Effect.gen(function* () {
      const sql = yield* Database;
      return yield* Effect.result(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              SELECT invitation_id
              FROM recruitment_invitations
              WHERE invitation_id = ${cohort.raceInvitationId}
              FOR UPDATE
            `;
            return yield* Effect.fail("ForcedRollbackAfterRowLock");
          }),
        ),
      );
    }).pipe(
      Effect.provide(makeProofLayer(databaseUrl, "recruitment-invitation-response-proof-rollback")),
    );

    const lockReleased = yield* Effect.gen(function* () {
      const sql = yield* Database;
      return yield* sql
        .withTransaction(
          sql`
            SELECT invitation_id
            FROM recruitment_invitations
            WHERE invitation_id = ${cohort.raceInvitationId}
            FOR UPDATE NOWAIT
          `,
        )
        .pipe(Effect.as(true));
    }).pipe(
      Effect.provide(
        makeProofLayer(databaseUrl, "recruitment-invitation-response-proof-release-check"),
      ),
    );

    const readyA = yield* Deferred.make<void>();
    const readyB = yield* Deferred.make<void>();
    const start = yield* Deferred.make<void>();
    const fiberA = yield* Effect.forkScoped(
      contender("confirm", readyA, start).pipe(
        Effect.provide(
          makeProofLayer(databaseUrl, "recruitment-invitation-response-proof-contender-a"),
        ),
      ),
    );
    const fiberB = yield* Effect.forkScoped(
      contender("reject", readyB, start).pipe(
        Effect.provide(
          makeProofLayer(databaseUrl, "recruitment-invitation-response-proof-contender-b"),
        ),
      ),
    );
    yield* Deferred.await(readyA);
    yield* Deferred.await(readyB);
    yield* Deferred.succeed(start, undefined);
    const contenders = yield* Effect.all([Fiber.join(fiberA), Fiber.join(fiberB)], {
      concurrency: "unbounded",
    });

    const recording = makeRecordingNotificationGateway("2035-09-15T12:08:00.000Z");
    const raceDrainRecording = makeRecordingNotificationGateway("2035-09-15T12:03:30.000Z");
    const failingGateway = Layer.succeed(
      NotificationGateway,
      NotificationGateway.of({
        deliverInterviewInvitation: (request) =>
          Effect.fail(
            new RecruitmentNotificationDeliveryError({
              effectId: request.effectId,
              message: "Proof recording delivery failure",
            }),
          ),
        deliverInterviewInvitationResponse: (request) =>
          Effect.fail(
            new RecruitmentNotificationDeliveryError({
              effectId: request.effectId,
              message: "Proof recording delivery failure",
            }),
          ),
      }),
    );

    const durable = yield* Effect.gen(function* () {
      const sql = yield* Database;
      const recruitment = yield* Recruitment;
      const [raceRow] = yield* sql<{
        readonly responseState: string;
        readonly responseMessage: string | null;
        readonly responseRevision: number;
        readonly audits: string;
        readonly outbox: string;
      }>`
        SELECT
          invitation.response_state AS "responseState",
          invitation.response_message AS "responseMessage",
          invitation.response_revision AS "responseRevision",
          (
            SELECT count(*)::text
            FROM recruitment_invitation_response_audit
            WHERE invitation_id = invitation.invitation_id
          ) AS audits,
          (
            SELECT count(*)::text
            FROM recruitment_invitation_response_outbox
            WHERE invitation_id = invitation.invitation_id
          ) AS outbox
        FROM recruitment_invitations AS invitation
        WHERE invitation.invitation_id = ${cohort.raceInvitationId}
      `;
      const invalidRelationalWrite = yield* Effect.result(sql`
        UPDATE recruitment_invitations
        SET response_state = 'Pending',
          response_message = 'illegal partial response',
          responded_at = ${responseInstant},
          response_revision = 0
        WHERE invitation_id = ${cohort.raceInvitationId}
      `);
      yield* deliverNextRecruitmentInvitationResponse(
        "invitation-response-proof-race-drain",
        "2035-09-15T12:03:30.000Z",
      ).pipe(Effect.provide(raceDrainRecording.layer));

      const deliveryRecorded = yield* recruitment.rejectInvitation(
        RecruitmentInvitationCapabilitySchema.make(deliveryCapability),
        { message: validNearbyMessage },
        { now: "2035-09-15T12:04:00.000Z" },
      );
      const [validNearby] = yield* sql<{ readonly stored: boolean }>`
        SELECT
          invitation.response_message = ${validNearbyMessage}
          AND audit.response_message = ${validNearbyMessage}
          AND outbox.response_message = ${validNearbyMessage}
          AND (outbox.payload_json ->> 'responseMessage') = ${validNearbyMessage}
            AS stored
        FROM recruitment_invitations AS invitation
        INNER JOIN recruitment_invitation_response_audit AS audit
          ON audit.invitation_id = invitation.invitation_id
        INNER JOIN recruitment_invitation_response_outbox AS outbox
          ON outbox.invitation_id = invitation.invitation_id
        WHERE invitation.invitation_id = ${cohort.deliveryInvitationId}
      `;
      const failedDelivery = yield* deliverNextRecruitmentInvitationResponse(
        "invitation-response-proof-failed-claim",
        "2035-09-15T12:05:00.000Z",
      ).pipe(Effect.provide(failingGateway));
      const [afterFailure] = yield* sql<{
        readonly responseState: string;
        readonly responseRevision: number;
        readonly audits: string;
        readonly outboxStatus: string;
      }>`
        SELECT
          invitation.response_state AS "responseState",
          invitation.response_revision AS "responseRevision",
          (
            SELECT count(*)::text
            FROM recruitment_invitation_response_audit
            WHERE invitation_id = invitation.invitation_id
          ) AS audits,
          (
            SELECT status
            FROM recruitment_invitation_response_outbox
            WHERE invitation_id = invitation.invitation_id
          ) AS "outboxStatus"
        FROM recruitment_invitations AS invitation
        WHERE invitation.invitation_id = ${cohort.deliveryInvitationId}
      `;
      const recoveredDelivery = yield* deliverNextRecruitmentInvitationResponse(
        "invitation-response-proof-recording-claim",
        "2035-09-15T12:06:00.000Z",
      ).pipe(Effect.provide(recording.layer));
      const [privacy] = yield* sql<{ readonly capabilityAbsent: boolean }>`
        SELECT NOT EXISTS (
          SELECT 1
          FROM (
            SELECT to_jsonb(invitation)::text AS artifact
            FROM recruitment_invitations AS invitation
            WHERE invitation.invitation_id IN (
              ${cohort.raceInvitationId},
              ${cohort.deliveryInvitationId}
            )
            UNION ALL
            SELECT to_jsonb(audit)::text
            FROM recruitment_invitation_response_audit AS audit
            WHERE audit.invitation_id IN (
              ${cohort.raceInvitationId},
              ${cohort.deliveryInvitationId}
            )
            UNION ALL
            SELECT to_jsonb(outbox)::text
            FROM recruitment_invitation_response_outbox AS outbox
            WHERE outbox.invitation_id IN (
              ${cohort.raceInvitationId},
              ${cohort.deliveryInvitationId}
            )
          ) AS canonical_artifacts
          WHERE canonical_artifacts.artifact LIKE ${`%${raceCapability}%`}
            OR canonical_artifacts.artifact LIKE ${`%${deliveryCapability}%`}
        ) AS "capabilityAbsent"
      `;
      return {
        raceRow,
        invalidRelationalWrite,
        deliveryRecorded,
        validNearbyMessageStored: validNearby?.stored === true,
        failedDelivery,
        afterFailure,
        recoveredDelivery,
        capabilityAbsent: privacy?.capabilityAbsent === true,
      };
    }).pipe(
      Effect.provide(makeProofLayer(databaseUrl, "recruitment-invitation-response-proof-observer")),
    );

    const outcomeTags = contenders.map((entry) =>
      entry.outcome._tag === "Success"
        ? `Recorded:${entry.outcome.success.responseState}`
        : entry.outcome.failure._tag,
    );
    const evidence = {
      specId: "0051" as const,
      database: "PostgreSQL" as const,
      schemaRevision: "13_native-organization-administration" as const,
      cohort: cohort.id,
      passed: true as const,
      concurrency: {
        independentConnectionIds: contenders.map((entry) => entry.pid),
        independentConnections: contenders[0]?.pid !== contenders[1]?.pid,
        acceptedTransitions: outcomeTags.filter((tag) => tag.startsWith("Recorded:")).length,
        alreadyRespondedRejections: outcomeTags.filter(
          (tag) => tag === "RecruitmentInvitationAlreadyResponded",
        ).length,
        storedState: durable.raceRow?.responseState ?? "Missing",
        auditRows: Number(durable.raceRow?.audits ?? "-1"),
        responseOutboxRows: Number(durable.raceRow?.outbox ?? "-1"),
      },
      rollback: {
        forcedRollbackObserved: rollbackResult._tag === "Failure",
        rowLockReleased: lockReleased,
      },
      relationalConstraint: {
        invalidResponseRejected: durable.invalidRelationalWrite._tag === "Failure",
      },
      messageConfinement: {
        ...messageConfinement,
        validNearbyMessageStored: durable.validNearbyMessageStored,
      },
      deliveryIsolation: {
        responseCommittedBeforeDelivery: durable.deliveryRecorded.responseState === "Rejected",
        failedDeliveryObserved: durable.failedDelivery._tag === "Failed",
        storedStateAfterFailure: durable.afterFailure?.responseState ?? "Missing",
        responseRevisionAfterFailure: durable.afterFailure?.responseRevision ?? -1,
        auditRowsAfterFailure: Number(durable.afterFailure?.audits ?? "-1"),
        outboxStatusAfterFailure: durable.afterFailure?.outboxStatus ?? "Missing",
        recordingRetryDelivered: durable.recoveredDelivery._tag === "Delivered",
        invitationRecordingRequests: recording.requests.length,
        responseRecordingRequests: recording.responseRequests.length,
      },
      privacy: {
        capability: "[REDACTED]" as const,
        canonicalCapabilityAbsent: durable.capabilityAbsent,
      },
    };

    assert.equal(evidence.concurrency.independentConnections, true);
    assert.equal(evidence.concurrency.acceptedTransitions, 1);
    assert.equal(evidence.concurrency.alreadyRespondedRejections, 1);
    assert.equal(evidence.concurrency.auditRows, 1);
    assert.equal(
      evidence.concurrency.responseOutboxRows,
      evidence.concurrency.storedState === "Accepted" ? 0 : 1,
    );
    assert.equal(evidence.rollback.forcedRollbackObserved, true);
    assert.equal(evidence.rollback.rowLockReleased, true);
    assert.equal(evidence.relationalConstraint.invalidResponseRejected, true);
    assert.deepEqual(evidence.messageConfinement, {
      migrationReplayed: true,
      invitationMessageRejected: true,
      auditMessageRejected: true,
      outboxMessageRejected: true,
      outboxPayloadRejected: true,
      rollbackPreserved: true,
      validNearbyMessageStored: true,
    });
    assert.deepEqual(evidence.deliveryIsolation, {
      responseCommittedBeforeDelivery: true,
      failedDeliveryObserved: true,
      storedStateAfterFailure: "Rejected",
      responseRevisionAfterFailure: 1,
      auditRowsAfterFailure: 1,
      outboxStatusAfterFailure: "Failed",
      recordingRetryDelivered: true,
      invitationRecordingRequests: 0,
      responseRecordingRequests: 1,
    });
    assert.equal(evidence.privacy.canonicalCapabilityAbsent, true);
    return evidence;
  });

const program = Effect.gen(function* () {
  const databaseUrl = yield* Config.redacted("DATABASE_URL");
  const evidence = yield* proof(databaseUrl);
  const canonicalEvidence = canonicalJson(evidence);
  assert.equal(canonicalEvidence.includes(raceCapability), false);
  assert.equal(canonicalEvidence.includes(deliveryCapability), false);
  assert.equal(canonicalEvidence.includes(capabilityShapedMessage), false);
  const evidenceSha256 = sha256Hex(canonicalJsonBytes(evidence));
  yield* Effect.sync(() =>
    process.stdout.write(`${canonicalJson({ ...evidence, evidenceSha256 })}\n`),
  );
});

Effect.runPromise(Effect.scoped(program)).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
});
