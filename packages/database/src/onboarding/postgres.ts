import { Effect } from "effect";
import { AdvisoryLockKey, lockAdvisory } from "../advisory-lock.js";
import { Database } from "../service.js";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import {
  OnboardingFailure,
  type AccountProvisionInput,
  type OnboardingCommand,
} from "@vektorprogrammet/domain/onboarding";

const fail = (code: OnboardingFailure["code"], status: OnboardingFailure["status"] = 409) =>
  Effect.fail(new OnboardingFailure({ code, status }));

export const onboardingApplication = (applicationId: string, departmentId: DepartmentId) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        applicantId: string;
      }>`SELECT applicant_id AS "applicantId" FROM public.admission_applications WHERE application_id=${applicationId} AND department_id=${departmentId}`;

      if (!rows[0]) return yield* fail("resource.not-found", 404);

      return rows[0];
    }),
  );

export const lockOnboardingApplicant = (applicantId: string) =>
  Database.use(
    (sql) =>
      sql`SELECT applicant_id FROM public.admission_applicants WHERE applicant_id=${applicantId} FOR UPDATE`,
  );

export const readOnboardingBoard = (departmentId: DepartmentId) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const items =
        yield* sql`SELECT a.application_id AS "applicationId",p.first_name AS "firstName",p.last_name AS "lastName",i.invitation_id AS "invitationId",CASE WHEN l.applicant_id IS NOT NULL THEN 'Linked' WHEN i.state='Open' AND i.expires_at<=transaction_timestamp() THEN 'Expired' ELSE COALESCE(i.state,'Absent') END AS state,COALESCE(d.state,'Absent') AS delivery,to_char(i.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt" FROM public.admission_applications a JOIN public.admission_applicants p USING(applicant_id) LEFT JOIN public.applicant_account_links l USING(applicant_id) LEFT JOIN LATERAL(SELECT * FROM public.applicant_account_invitations WHERE application_id=a.application_id ORDER BY generation DESC LIMIT 1)i ON true LEFT JOIN public.applicant_account_delivery d ON d.invitation_id=i.invitation_id WHERE a.department_id=${departmentId} ORDER BY a.submitted_at DESC,a.application_id`;

      return { departmentId, items };
    }),
  );

export const commandOnboarding = (input: {
  departmentId: DepartmentId;
  command: OnboardingCommand;
  actor: PersonId;
  now: string;
  invitationId: string;
  token: string;
  digest: string;
}) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const { applicantId } = yield* onboardingApplication(
        input.command.applicationId,
        input.departmentId,
      );

      yield* lockOnboardingApplicant(applicantId);

      if (input.command.action === "RetryDelivery") return;

      const linked =
        yield* sql`SELECT applicant_id FROM public.applicant_account_links WHERE applicant_id=${applicantId}`;

      if (linked.length) return yield* fail("onboarding.already-linked");

      const old = yield* sql<{
        invitationId: string;
      }>`UPDATE public.applicant_account_invitations SET state='Revoked' WHERE applicant_id=${applicantId} AND state='Open' AND (${input.command.action}='Issue' OR application_id=${input.command.applicationId}) RETURNING invitation_id AS "invitationId"`;

      for (const row of old) {
        yield* sql`UPDATE public.applicant_account_delivery SET state='Cancelled',secret=NULL,envelope=NULL,claim_id=NULL,claimed_at=NULL WHERE invitation_id=${row.invitationId} AND state<>'Delivered'`;
        yield* sql`INSERT INTO public.applicant_account_audit VALUES(${input.invitationId + ":revoke:" + row.invitationId},${applicantId},${row.invitationId},${input.actor},'Revoked',${input.now})`;
      }

      if (input.command.action === "Revoke") return;
      const expiresAt = new Date(Date.parse(input.now) + 86400000).toISOString();
      yield* sql`INSERT INTO public.applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES(${input.invitationId},${input.command.applicationId},${applicantId},${input.digest},${expiresAt},'Open',${input.actor},${input.now})`;
      yield* sql`INSERT INTO public.applicant_account_delivery(invitation_id,state,secret,recipient) SELECT ${input.invitationId},'Pending',${input.token},email FROM public.admission_applicants WHERE applicant_id=${applicantId}`;
      yield* sql`INSERT INTO public.applicant_account_audit VALUES(${input.invitationId + ":issue"},${applicantId},${input.invitationId},${input.actor},'Issued',${input.now})`;
    }),
  );

export const claimOnboarding = <E, R>(input: {
  digest: string;
  now: string;
  identity:
    | { mode: "ExistingAccount"; personId: PersonId }
    | { mode: "NewAccount"; personId: PersonId; passwordHash: string };
  provision: (input: AccountProvisionInput) => Effect.Effect<void, E, R>;
}) =>
  Database.use((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const found = yield* sql<{
          applicantId: string;
        }>`SELECT applicant_id AS "applicantId" FROM public.applicant_account_invitations WHERE token_digest=${input.digest}`;

        if (!found[0]) return yield* fail("onboarding.claim-invalid", 400);
        yield* lockAdvisory(sql, AdvisoryLockKey.personAuthorization(input.identity.personId));
        yield* lockOnboardingApplicant(found[0].applicantId);

        const rows = yield* sql<{
          invitationId: string;
          applicantId: string;
          departmentId: DepartmentId;
          firstName: string;
          lastName: string;
          email: string;
          phone: string;
          observedAt: string;
        }>`SELECT i.invitation_id AS "invitationId",i.applicant_id AS "applicantId",a.department_id AS "departmentId",p.first_name AS "firstName",p.last_name AS "lastName",d.recipient AS email,p.phone,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt" FROM public.applicant_account_invitations i JOIN public.applicant_account_delivery d USING(invitation_id) JOIN public.admission_applicants p USING(applicant_id) JOIN public.admission_applications a USING(application_id) WHERE i.token_digest=${input.digest} AND i.state='Open' AND i.expires_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM public.applicant_account_links l WHERE l.applicant_id=i.applicant_id)`;

        const row = rows[0];

        if (!row) return yield* fail("onboarding.claim-invalid", 400);

        if (input.identity.mode === "NewAccount")
          yield* input.provision({ ...row, ...input.identity, now: row.observedAt });
        yield* sql`INSERT INTO public.applicant_account_links VALUES(${row.applicantId},${input.identity.personId},${row.observedAt},${row.invitationId})`;
        yield* sql`UPDATE public.applicant_account_invitations SET state='Claimed' WHERE invitation_id=${row.invitationId}`;
        yield* sql`UPDATE public.applicant_account_delivery SET state='Cancelled',secret=NULL,envelope=NULL,claim_id=NULL,claimed_at=NULL WHERE invitation_id=${row.invitationId} AND state<>'Delivered'`;
        yield* sql`INSERT INTO public.applicant_account_audit VALUES(${row.invitationId + ":claim"},${row.applicantId},${row.invitationId},${input.identity.personId},${input.identity.mode === "NewAccount" ? "NewAccountClaimed" : "ExistingAccountClaimed"},${row.observedAt})`;

        return { state: "Claimed" as const, departmentId: row.departmentId };
      }),
    ),
  );

export const checkOnboardingClaim = (digest: string, now: string) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const rows =
        yield* sql`SELECT invitation_id FROM public.applicant_account_invitations i WHERE token_digest=${digest} AND state='Open' AND expires_at>${now}::timestamptz AND NOT EXISTS(SELECT 1 FROM public.applicant_account_links l WHERE l.applicant_id=i.applicant_id)`;

      if (!rows.length) return yield* fail("onboarding.claim-invalid", 400);
    }),
  );
