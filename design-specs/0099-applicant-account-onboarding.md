# 0099 — Applicant account onboarding

Status: frozen for local implementation, 2026-09-06.
Authority: accepted continuation plan and operator instruction to proceed.
Production delivery, real identity migration and deployment remain separately gated.

## Journey and goal

A scoped coordinator invites a submitted applicant to establish their account.
The applicant opens the delivered invitation and either creates a native account
or explicitly links their signed-in account. They can then self-request department
affiliation and follow the existing 0096 approval and placement journey.

Applicant identity, account credentials and volunteer affiliation have separate
owners. Email equality is never account ownership proof. Interview invitation
acceptance is not assistant admission; this contract introduces no acceptance gate.

## Source and reuse

- Applicant/application facts: packages/domain/src/application/schema.ts and postgres.ts.
- Existing submission activation intent: design-specs/0039-public-applicant-admission.md;
  its digest is not an account claim credential.
- Person/auth relation: packages/database/migrations/0015-native-identity-better-auth.sql.
- Legacy behavior: apps/server/src/App/Admission/Infrastructure/ApplicationAdmission.php,
  apps/server/src/App/Identity/Infrastructure/UserRegistration.php and
  apps/server/src/App/Operations/Infrastructure/Subscriber/AssistantHistorySubscriber.php.
- Reuse native authorization, ETags, command receipts, acknowledged delivery,
  password hashing from installed Better Auth and 0096 affiliation/placement.
  Fixture identity seeding is not an onboarding implementation.

## Frozen behavior

1. A currently active department leader or global administrator may issue/revoke an
   invitation for an application in their canonical scope. Derive recipient,
   ApplicantId and department from that application; no arbitrary recipient or
   target Person input. Ordinary members and wrong-department leaders are denied.
2. Store one authoritative immutable ApplicantId-to-PersonId association with FKs.
   ApplicantId is unique. Multiple historical applicants may refer to one Person;
   each requires its own explicit claim proof. Do not merge applicants by email.
3. Use a new purpose-specific opaque token (at least 256 random bits), stored only
   as a digest at the claim authority, expiring after 24 hours. Protected delivery
   state may retain the secret only as needed for delivery and must erase it upon
   acknowledgement/expiry. Never place it in audit, logs or retained evidence.
   GET previews only; POST consumes. Reissue invalidates earlier claims.
4. Invitation delivery is durable and acknowledged through an explicit adapter.
   Missing configuration/failure remains retryable, never Delivered. A stable
   effect identity fences concurrent/retried delivery. State at-least-once limits.
5. New-account claim requires valid invitation plus chosen password satisfying
   Better Auth policy. Person, initial profile/contact, auth user, credential,
   association and claim consumption commit atomically. No public signup path is
   enabled; no partial account may survive failure. Auth email collision requires
   sign-in/recovery; it cannot overwrite or implicitly link an existing account.
6. Existing-account claim requires invitation possession and authenticated current
   Person. Preserve their credentials, profile and login email exactly. Session
   identity is authoritative; a submitted PersonId cannot select another person.
7. Claim is single-use. Concurrent claims yield one association and at most one
   new account. An existing association cannot move to another Person. Expired,
   revoked, wrong-purpose or consumed claims cannot mutate credentials or links.
8. Fresh authorization precedes invitation receipt replay. Exact command retry
   returns the same result/effect; conflicting replay rejects. Version conflicts
   preserve user drafts. Record bounded actor/time/action audit in the owning
   transaction. Account creation or claim grants no team role or active affiliation.
9. After claim, use explicit existing self-request/manager approval. Historical
   applications do not silently select a current semester or create a placement.
10. UI provides invitation issue/revoke, generic claim failure, existing-account
    sign-in/recovery direction and new-password/confirmation fields. No private
    directory or arbitrary account lookup. Account claim and password-recovery
    pages are distinct; 0054.2 owns password reset. Tokens must not enter POST URL.

## Falsifiers and acceptance

Run synthetic public application → coordinator invitation → acknowledged loopback
mail → browser claim → native login → affiliation self-request → approval → placement
against actual PostgreSQL/backend/dashboard. Observe independent SQL facts.

Also observe existing-account claim without profile/credential replacement;
wrong scope/member/inactive/revoked issuer denial; email collision without session;
GET nonmutation; expired/revoked/reused tokens; conflicting/concurrent claims;
transaction failure with zero partial account/link; delivery failure/retry/restart;
no duplicate command effects; original application/history preservation; keyboard,
mobile and accessibility behavior. Assert secrets absent from retained artifacts.

Implementation, runtime observation and production release are separate claims.
Local HTTP mailbox evidence is not evidence of production email delivery.

## Work ownership

Onboarding worker owns this journey in an isolated worktree. Migration 0035 is
reserved; 0034 and password recovery/auth-engine configuration belong to 0054.2.
Coordinate shared composition files through integration. No provider deployment,
production recipient, real account conversion or remote mutation is authorized.
