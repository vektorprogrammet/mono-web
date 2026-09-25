-- Instants are millisecond values. The domain holds Effect DateTime.Utc, which has millisecond
-- precision, while PostgreSQL timestamptz keeps microseconds. A stored microsecond value would
-- decode to a different instant, so keyset cursors and equality predicates built from a domain
-- value could skip or repeat rows. This migration truncates existing values once, makes clock
-- defaults millisecond-exact, and rejects any later sub-millisecond write. The Migrator's own
-- bookkeeping column is left alone.
--
-- Truncation is monotonic: a <= b stays true, and [start, end) ranges cannot begin to overlap.
-- A strict ordering CHECK or a UNIQUE key can still collide when two values share a millisecond.
-- Such a collision aborts this migration with the violated constraint and its row; nothing is
-- repaired automatically.

-- Update guards, revision triggers, and the content version rule would reject, bump, or discard
-- the representational update. They are bypassed only for it, as in migration 48.
ALTER TABLE auth.account DISABLE TRIGGER account_access_write;
ALTER TABLE auth.identity_security_audit DISABLE TRIGGER identity_security_audit_append_only;
ALTER TABLE auth.oauth_security_audit DISABLE TRIGGER oauth_security_audit_no_update;
ALTER TABLE auth.session DISABLE TRIGGER session_access_renewal;
ALTER TABLE public.admission_period_semesters DISABLE TRIGGER admission_period_semesters_http_revision;
ALTER TABLE public.admission_returning_command_receipts DISABLE TRIGGER admission_returning_registration_receipts_immutable;
ALTER TABLE public.admission_returning_registrations DISABLE TRIGGER admission_returning_registration_immutable;
ALTER TABLE public.applicant_account_audit DISABLE TRIGGER applicant_account_audit_immutable;
ALTER TABLE public.applicant_account_delivery DISABLE TRIGGER applicant_account_envelope_guard;
ALTER TABLE public.applicant_account_invitations DISABLE TRIGGER applicant_account_invitation_guard;
ALTER TABLE public.applicant_account_links DISABLE TRIGGER applicant_account_link_immutable;
ALTER TABLE public.assistant_service_history DISABLE TRIGGER assistant_service_history_append_only;
ALTER TABLE public.content_article_versions DISABLE RULE content_article_versions_no_update;
ALTER TABLE public.content_publication_audit DISABLE TRIGGER content_publication_audit_immutable;
ALTER TABLE public.current_assignment_imports DISABLE TRIGGER current_assignment_imports_append_only;
ALTER TABLE public.current_assignment_snapshots DISABLE TRIGGER current_assignment_snapshots_append_only;
ALTER TABLE public.economy_receipt_outbox DISABLE TRIGGER receipt_delivery_envelope_immutable;
ALTER TABLE public.economy_receipt_settlements DISABLE TRIGGER economy_receipt_settlements_immutable;
ALTER TABLE public.historical_service_reference_provenance DISABLE TRIGGER historical_service_reference_provenance_append_only;
ALTER TABLE public.historical_service_snapshots DISABLE TRIGGER historical_service_snapshots_append_only;
ALTER TABLE public.native_survey_definitions DISABLE TRIGGER native_survey_definitions_school_lifecycle_guard;
ALTER TABLE public.organization_cohort_snapshots DISABLE TRIGGER organization_cohort_snapshots_append_only;
ALTER TABLE public.organization_command_receipts DISABLE TRIGGER organization_command_receipts_creation_links;
ALTER TABLE public.organization_creation_audit DISABLE TRIGGER organization_creation_audit_links;
ALTER TABLE public.organization_global_administrator_grants DISABLE TRIGGER organization_global_administrator_grants_profile_http_version;
ALTER TABLE public.organization_lifecycle_history DISABLE TRIGGER organization_lifecycle_history_immutable;
ALTER TABLE public.organization_memberships DISABLE TRIGGER organization_memberships_profile_http_version;
ALTER TABLE public.organization_teams DISABLE TRIGGER organization_teams_creation_links;
ALTER TABLE public.profile_self_edit_commands DISABLE TRIGGER profile_self_edit_commands_immutable;
ALTER TABLE public.receipt_cohort_snapshots DISABLE TRIGGER receipt_cohort_snapshots_append_only;
ALTER TABLE public.recruitment_interview_cancellations DISABLE TRIGGER recruitment_interview_cancellations_immutable;
ALTER TABLE public.recruitment_interview_completion_outbox DISABLE TRIGGER recruitment_interview_completion_envelope_immutable;
ALTER TABLE public.recruitment_interview_conducts DISABLE TRIGGER recruitment_interview_conducts_immutable;
ALTER TABLE public.recruitment_interview_correction_assessments DISABLE TRIGGER recruitment_interview_correction_assessments_immutable;
ALTER TABLE public.recruitment_interview_correction_audit DISABLE TRIGGER recruitment_interview_correction_audit_immutable;
ALTER TABLE public.recruitment_interview_correction_command_receipts DISABLE TRIGGER recruitment_interview_correction_receipts_immutable;
ALTER TABLE public.recruitment_interview_lifecycle_audit DISABLE TRIGGER recruitment_interview_lifecycle_audit_immutable;
ALTER TABLE public.recruitment_interview_lifecycle_command_receipts DISABLE TRIGGER recruitment_interview_lifecycle_command_receipts_immutable;
ALTER TABLE public.recruitment_interview_schedules DISABLE TRIGGER recruitment_interview_schedules_immutable;
ALTER TABLE public.recruitment_invitation_response_audit DISABLE TRIGGER recruitment_invitation_response_audit_immutable, DISABLE TRIGGER recruitment_invitation_response_audit_links;
ALTER TABLE public.recruitment_invitation_response_outbox DISABLE TRIGGER recruitment_invitation_response_outbox_links, DISABLE TRIGGER recruitment_invitation_response_outbox_request_immutable;
ALTER TABLE public.recruitment_invitations DISABLE TRIGGER recruitment_invitations_response_links;
ALTER TABLE public.recruitment_questionnaire_history DISABLE TRIGGER recruitment_questionnaire_history_immutable;
ALTER TABLE public.recruitment_schedule_command_receipts DISABLE TRIGGER recruitment_schedule_receipts_immutable;
ALTER TABLE public.recruitment_staffing_history DISABLE TRIGGER recruitment_staffing_history_immutable;
ALTER TABLE public.school_service_absences DISABLE TRIGGER school_service_absence_immutable;
ALTER TABLE public.school_service_closures DISABLE TRIGGER school_service_closure_immutable;
ALTER TABLE public.school_service_commitments DISABLE TRIGGER school_service_commitment_immutable;
ALTER TABLE public.school_service_coverage_acknowledgements DISABLE TRIGGER school_service_coverage_acknowledgement_immutable;
ALTER TABLE public.school_service_coverage_audit DISABLE TRIGGER school_service_coverage_audit_immutable;
ALTER TABLE public.school_service_decisions DISABLE TRIGGER school_service_decision_immutable;
ALTER TABLE public.school_service_dispatch_notification_outbox DISABLE TRIGGER school_service_dispatch_notification_guard;
ALTER TABLE public.school_service_notification_outbox DISABLE TRIGGER school_service_notification_guard;
ALTER TABLE public.school_service_occurrences DISABLE TRIGGER school_service_occurrence_immutable;
ALTER TABLE public.school_service_proposals DISABLE TRIGGER school_service_proposal_guard;
ALTER TABLE public.school_service_substitute_offer_responses DISABLE TRIGGER school_service_substitute_offer_response_immutable;
ALTER TABLE public.school_service_substitute_offer_withdrawals DISABLE TRIGGER school_service_substitute_offer_withdrawal_immutable;
ALTER TABLE public.school_service_substitute_offers DISABLE TRIGGER school_service_offer_live_guard, DISABLE TRIGGER school_service_offer_reserve_person, DISABLE TRIGGER school_service_substitute_offer_guard;
ALTER TABLE public.school_survey_audit DISABLE TRIGGER school_survey_audit_guard;
ALTER TABLE public.schools_administration_audit DISABLE TRIGGER schools_administration_audit_immutable;
ALTER TABLE public.service_principal_grant_audit DISABLE TRIGGER service_principal_grant_audit_no_update;
ALTER TABLE public.social_event_audit DISABLE TRIGGER social_event_audit_immutable;
ALTER TABLE public.social_event_command_receipts DISABLE TRIGGER social_event_command_receipts_immutable;
ALTER TABLE public.team_application_outbox DISABLE TRIGGER team_application_outbox_guard;

UPDATE auth.account
SET "accessTokenExpiresAt" = date_trunc('milliseconds', "accessTokenExpiresAt", 'UTC'),
  "createdAt" = date_trunc('milliseconds', "createdAt", 'UTC'),
  "refreshTokenExpiresAt" = date_trunc('milliseconds', "refreshTokenExpiresAt", 'UTC'),
  "updatedAt" = date_trunc('milliseconds', "updatedAt", 'UTC')
WHERE "accessTokenExpiresAt" <> date_trunc('milliseconds', "accessTokenExpiresAt", 'UTC')
  OR "createdAt" <> date_trunc('milliseconds', "createdAt", 'UTC')
  OR "refreshTokenExpiresAt" <> date_trunc('milliseconds', "refreshTokenExpiresAt", 'UTC')
  OR "updatedAt" <> date_trunc('milliseconds', "updatedAt", 'UTC');

UPDATE auth.identity_security_audit
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE auth.jwks
SET "createdAt" = date_trunc('milliseconds', "createdAt", 'UTC'),
  "expiresAt" = date_trunc('milliseconds', "expiresAt", 'UTC')
WHERE "createdAt" <> date_trunc('milliseconds', "createdAt", 'UTC')
  OR "expiresAt" <> date_trunc('milliseconds', "expiresAt", 'UTC');

UPDATE auth."oauthAccessToken"
SET "createdAt" = date_trunc('milliseconds', "createdAt", 'UTC'),
  "expiresAt" = date_trunc('milliseconds', "expiresAt", 'UTC'),
  revoked = date_trunc('milliseconds', revoked, 'UTC')
WHERE "createdAt" <> date_trunc('milliseconds', "createdAt", 'UTC')
  OR "expiresAt" <> date_trunc('milliseconds', "expiresAt", 'UTC')
  OR revoked <> date_trunc('milliseconds', revoked, 'UTC');

UPDATE auth."oauthClient"
SET "createdAt" = date_trunc('milliseconds', "createdAt", 'UTC'),
  "updatedAt" = date_trunc('milliseconds', "updatedAt", 'UTC')
WHERE "createdAt" <> date_trunc('milliseconds', "createdAt", 'UTC')
  OR "updatedAt" <> date_trunc('milliseconds', "updatedAt", 'UTC');

UPDATE auth."oauthClientAssertion"
SET "expiresAt" = date_trunc('milliseconds', "expiresAt", 'UTC')
WHERE "expiresAt" <> date_trunc('milliseconds', "expiresAt", 'UTC');

UPDATE auth."oauthClientResource"
SET "createdAt" = date_trunc('milliseconds', "createdAt", 'UTC')
WHERE "createdAt" <> date_trunc('milliseconds', "createdAt", 'UTC');

UPDATE auth."oauthConsent"
SET "createdAt" = date_trunc('milliseconds', "createdAt", 'UTC'),
  "updatedAt" = date_trunc('milliseconds', "updatedAt", 'UTC')
WHERE "createdAt" <> date_trunc('milliseconds', "createdAt", 'UTC')
  OR "updatedAt" <> date_trunc('milliseconds', "updatedAt", 'UTC');

UPDATE auth."oauthRefreshToken"
SET "authTime" = date_trunc('milliseconds', "authTime", 'UTC'),
  "createdAt" = date_trunc('milliseconds', "createdAt", 'UTC'),
  "expiresAt" = date_trunc('milliseconds', "expiresAt", 'UTC'),
  revoked = date_trunc('milliseconds', revoked, 'UTC'),
  "rotatedAt" = date_trunc('milliseconds', "rotatedAt", 'UTC'),
  "rotationReplayExpiresAt" = date_trunc('milliseconds', "rotationReplayExpiresAt", 'UTC')
WHERE "authTime" <> date_trunc('milliseconds', "authTime", 'UTC')
  OR "createdAt" <> date_trunc('milliseconds', "createdAt", 'UTC')
  OR "expiresAt" <> date_trunc('milliseconds', "expiresAt", 'UTC')
  OR revoked <> date_trunc('milliseconds', revoked, 'UTC')
  OR "rotatedAt" <> date_trunc('milliseconds', "rotatedAt", 'UTC')
  OR "rotationReplayExpiresAt" <> date_trunc('milliseconds', "rotationReplayExpiresAt", 'UTC');

UPDATE auth."oauthResource"
SET "createdAt" = date_trunc('milliseconds', "createdAt", 'UTC'),
  "updatedAt" = date_trunc('milliseconds', "updatedAt", 'UTC')
WHERE "createdAt" <> date_trunc('milliseconds', "createdAt", 'UTC')
  OR "updatedAt" <> date_trunc('milliseconds', "updatedAt", 'UTC');

UPDATE auth.oauth_access_token_state
SET expires_at = date_trunc('milliseconds', expires_at, 'UTC'),
  issued_at = date_trunc('milliseconds', issued_at, 'UTC'),
  revoked_at = date_trunc('milliseconds', revoked_at, 'UTC')
WHERE expires_at <> date_trunc('milliseconds', expires_at, 'UTC')
  OR issued_at <> date_trunc('milliseconds', issued_at, 'UTC')
  OR revoked_at <> date_trunc('milliseconds', revoked_at, 'UTC');

UPDATE auth.oauth_client_bindings
SET created_at = date_trunc('milliseconds', created_at, 'UTC'),
  secret_expires_at = date_trunc('milliseconds', secret_expires_at, 'UTC'),
  updated_at = date_trunc('milliseconds', updated_at, 'UTC')
WHERE created_at <> date_trunc('milliseconds', created_at, 'UTC')
  OR secret_expires_at <> date_trunc('milliseconds', secret_expires_at, 'UTC')
  OR updated_at <> date_trunc('milliseconds', updated_at, 'UTC');

UPDATE auth.oauth_refresh_families
SET absolute_expires_at = date_trunc('milliseconds', absolute_expires_at, 'UTC'),
  created_at = date_trunc('milliseconds', created_at, 'UTC'),
  inactivity_expires_at = date_trunc('milliseconds', inactivity_expires_at, 'UTC'),
  last_used_at = date_trunc('milliseconds', last_used_at, 'UTC'),
  revoked_at = date_trunc('milliseconds', revoked_at, 'UTC')
WHERE absolute_expires_at <> date_trunc('milliseconds', absolute_expires_at, 'UTC')
  OR created_at <> date_trunc('milliseconds', created_at, 'UTC')
  OR inactivity_expires_at <> date_trunc('milliseconds', inactivity_expires_at, 'UTC')
  OR last_used_at <> date_trunc('milliseconds', last_used_at, 'UTC')
  OR revoked_at <> date_trunc('milliseconds', revoked_at, 'UTC');

UPDATE auth.oauth_security_audit
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE auth.password_reset_email_outbox
SET claimed_at = date_trunc('milliseconds', claimed_at, 'UTC'),
  created_at = date_trunc('milliseconds', created_at, 'UTC'),
  delivered_at = date_trunc('milliseconds', delivered_at, 'UTC')
WHERE claimed_at <> date_trunc('milliseconds', claimed_at, 'UTC')
  OR created_at <> date_trunc('milliseconds', created_at, 'UTC')
  OR delivered_at <> date_trunc('milliseconds', delivered_at, 'UTC');

UPDATE auth.session
SET "createdAt" = date_trunc('milliseconds', "createdAt", 'UTC'),
  "expiresAt" = date_trunc('milliseconds', "expiresAt", 'UTC'),
  "updatedAt" = date_trunc('milliseconds', "updatedAt", 'UTC')
WHERE "createdAt" <> date_trunc('milliseconds', "createdAt", 'UTC')
  OR "expiresAt" <> date_trunc('milliseconds', "expiresAt", 'UTC')
  OR "updatedAt" <> date_trunc('milliseconds', "updatedAt", 'UTC');

UPDATE auth."user"
SET "createdAt" = date_trunc('milliseconds', "createdAt", 'UTC'),
  "updatedAt" = date_trunc('milliseconds', "updatedAt", 'UTC')
WHERE "createdAt" <> date_trunc('milliseconds', "createdAt", 'UTC')
  OR "updatedAt" <> date_trunc('milliseconds', "updatedAt", 'UTC');

UPDATE auth.verification
SET "createdAt" = date_trunc('milliseconds', "createdAt", 'UTC'),
  "expiresAt" = date_trunc('milliseconds', "expiresAt", 'UTC'),
  "updatedAt" = date_trunc('milliseconds', "updatedAt", 'UTC')
WHERE "createdAt" <> date_trunc('milliseconds', "createdAt", 'UTC')
  OR "expiresAt" <> date_trunc('milliseconds', "expiresAt", 'UTC')
  OR "updatedAt" <> date_trunc('milliseconds', "updatedAt", 'UTC');

UPDATE public.admission_application_audit
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE public.admission_application_command_receipts
SET committed_at = date_trunc('milliseconds', committed_at, 'UTC')
WHERE committed_at <> date_trunc('milliseconds', committed_at, 'UTC');

UPDATE public.admission_application_outbox
SET claimed_at = date_trunc('milliseconds', claimed_at, 'UTC')
WHERE claimed_at <> date_trunc('milliseconds', claimed_at, 'UTC');

UPDATE public.admission_applications
SET submitted_at = date_trunc('milliseconds', submitted_at, 'UTC')
WHERE submitted_at <> date_trunc('milliseconds', submitted_at, 'UTC');

UPDATE public.admission_period_audit
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE public.admission_period_command_receipts
SET committed_at = date_trunc('milliseconds', committed_at, 'UTC')
WHERE committed_at <> date_trunc('milliseconds', committed_at, 'UTC');

UPDATE public.admission_period_outbox
SET claimed_at = date_trunc('milliseconds', claimed_at, 'UTC')
WHERE claimed_at <> date_trunc('milliseconds', claimed_at, 'UTC');

UPDATE public.admission_period_semesters
SET end_at = date_trunc('milliseconds', end_at, 'UTC'),
  start_at = date_trunc('milliseconds', start_at, 'UTC')
WHERE end_at <> date_trunc('milliseconds', end_at, 'UTC')
  OR start_at <> date_trunc('milliseconds', start_at, 'UTC');

UPDATE public.admission_periods
SET end_at = date_trunc('milliseconds', end_at, 'UTC'),
  start_at = date_trunc('milliseconds', start_at, 'UTC')
WHERE end_at <> date_trunc('milliseconds', end_at, 'UTC')
  OR start_at <> date_trunc('milliseconds', start_at, 'UTC');

UPDATE public.admission_returning_command_receipts
SET committed_at = date_trunc('milliseconds', committed_at, 'UTC')
WHERE committed_at <> date_trunc('milliseconds', committed_at, 'UTC');

UPDATE public.admission_returning_registrations
SET registered_at = date_trunc('milliseconds', registered_at, 'UTC')
WHERE registered_at <> date_trunc('milliseconds', registered_at, 'UTC');

UPDATE public.applicant_account_audit
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE public.applicant_account_delivery
SET claimed_at = date_trunc('milliseconds', claimed_at, 'UTC')
WHERE claimed_at <> date_trunc('milliseconds', claimed_at, 'UTC');

UPDATE public.applicant_account_invitations
SET expires_at = date_trunc('milliseconds', expires_at, 'UTC'),
  issued_at = date_trunc('milliseconds', issued_at, 'UTC')
WHERE expires_at <> date_trunc('milliseconds', expires_at, 'UTC')
  OR issued_at <> date_trunc('milliseconds', issued_at, 'UTC');

UPDATE public.applicant_account_links
SET linked_at = date_trunc('milliseconds', linked_at, 'UTC')
WHERE linked_at <> date_trunc('milliseconds', linked_at, 'UTC');

UPDATE public.assistant_placement_audit
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE public.assistant_service_history
SET imported_at = date_trunc('milliseconds', imported_at, 'UTC')
WHERE imported_at <> date_trunc('milliseconds', imported_at, 'UTC');

UPDATE public.authz_rules
SET end_at = date_trunc('milliseconds', end_at, 'UTC'),
  start_at = date_trunc('milliseconds', start_at, 'UTC')
WHERE end_at <> date_trunc('milliseconds', end_at, 'UTC')
  OR start_at <> date_trunc('milliseconds', start_at, 'UTC');

UPDATE public.authz_tag_assignments
SET end_at = date_trunc('milliseconds', end_at, 'UTC'),
  start_at = date_trunc('milliseconds', start_at, 'UTC')
WHERE end_at <> date_trunc('milliseconds', end_at, 'UTC')
  OR start_at <> date_trunc('milliseconds', start_at, 'UTC');

UPDATE public.contact_rate_windows
SET expires_at = date_trunc('milliseconds', expires_at, 'UTC')
WHERE expires_at <> date_trunc('milliseconds', expires_at, 'UTC');

UPDATE public.content_article_versions
SET published_at = date_trunc('milliseconds', published_at, 'UTC')
WHERE published_at <> date_trunc('milliseconds', published_at, 'UTC');

UPDATE public.content_articles
SET created_at = date_trunc('milliseconds', created_at, 'UTC'),
  updated_at = date_trunc('milliseconds', updated_at, 'UTC')
WHERE created_at <> date_trunc('milliseconds', created_at, 'UTC')
  OR updated_at <> date_trunc('milliseconds', updated_at, 'UTC');

UPDATE public.content_publication_audit
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE public.content_publication_command_receipts
SET committed_at = date_trunc('milliseconds', committed_at, 'UTC')
WHERE committed_at <> date_trunc('milliseconds', committed_at, 'UTC');

UPDATE public.current_assignment_imports
SET imported_at = date_trunc('milliseconds', imported_at, 'UTC')
WHERE imported_at <> date_trunc('milliseconds', imported_at, 'UTC');

UPDATE public.current_assignment_snapshots
SET imported_at = date_trunc('milliseconds', imported_at, 'UTC')
WHERE imported_at <> date_trunc('milliseconds', imported_at, 'UTC');

UPDATE public.economy_payment_authorities
SET end_at = date_trunc('milliseconds', end_at, 'UTC'),
  start_at = date_trunc('milliseconds', start_at, 'UTC')
WHERE end_at <> date_trunc('milliseconds', end_at, 'UTC')
  OR start_at <> date_trunc('milliseconds', start_at, 'UTC');

UPDATE public.economy_receipt_approval_grants
SET end_at = date_trunc('milliseconds', end_at, 'UTC'),
  start_at = date_trunc('milliseconds', start_at, 'UTC')
WHERE end_at <> date_trunc('milliseconds', end_at, 'UTC')
  OR start_at <> date_trunc('milliseconds', start_at, 'UTC');

UPDATE public.economy_receipt_audit
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE public.economy_receipt_command_receipts
SET committed_at = date_trunc('milliseconds', committed_at, 'UTC')
WHERE committed_at <> date_trunc('milliseconds', committed_at, 'UTC');

UPDATE public.economy_receipt_outbox
SET claimed_at = date_trunc('milliseconds', claimed_at, 'UTC')
WHERE claimed_at <> date_trunc('milliseconds', claimed_at, 'UTC');

UPDATE public.economy_receipt_settlement_grants
SET end_at = date_trunc('milliseconds', end_at, 'UTC'),
  start_at = date_trunc('milliseconds', start_at, 'UTC')
WHERE end_at <> date_trunc('milliseconds', end_at, 'UTC')
  OR start_at <> date_trunc('milliseconds', start_at, 'UTC');

UPDATE public.economy_receipt_settlements
SET recorded_at = date_trunc('milliseconds', recorded_at, 'UTC'),
  settled_at = date_trunc('milliseconds', settled_at, 'UTC')
WHERE recorded_at <> date_trunc('milliseconds', recorded_at, 'UTC')
  OR settled_at <> date_trunc('milliseconds', settled_at, 'UTC');

UPDATE public.economy_receipts
SET approved_at = date_trunc('milliseconds', approved_at, 'UTC'),
  submitted_at = date_trunc('milliseconds', submitted_at, 'UTC')
WHERE approved_at <> date_trunc('milliseconds', approved_at, 'UTC')
  OR submitted_at <> date_trunc('milliseconds', submitted_at, 'UTC');

UPDATE public.historical_service_reference_provenance
SET imported_at = date_trunc('milliseconds', imported_at, 'UTC')
WHERE imported_at <> date_trunc('milliseconds', imported_at, 'UTC');

UPDATE public.historical_service_snapshots
SET imported_at = date_trunc('milliseconds', imported_at, 'UTC')
WHERE imported_at <> date_trunc('milliseconds', imported_at, 'UTC');

UPDATE public.native_http_idempotency_receipts
SET committed_at = date_trunc('milliseconds', committed_at, 'UTC'),
  full_expires_at = date_trunc('milliseconds', full_expires_at, 'UTC'),
  tombstoned_at = date_trunc('milliseconds', tombstoned_at, 'UTC')
WHERE committed_at <> date_trunc('milliseconds', committed_at, 'UTC')
  OR full_expires_at <> date_trunc('milliseconds', full_expires_at, 'UTC')
  OR tombstoned_at <> date_trunc('milliseconds', tombstoned_at, 'UTC');

UPDATE public.native_survey_definitions
SET closed_at = date_trunc('milliseconds', closed_at, 'UTC'),
  created_at = date_trunc('milliseconds', created_at, 'UTC')
WHERE closed_at <> date_trunc('milliseconds', closed_at, 'UTC')
  OR created_at <> date_trunc('milliseconds', created_at, 'UTC');

UPDATE public.organization_cohort_snapshots
SET recorded_at = date_trunc('milliseconds', recorded_at, 'UTC')
WHERE recorded_at <> date_trunc('milliseconds', recorded_at, 'UTC');

UPDATE public.organization_command_receipts
SET committed_at = date_trunc('milliseconds', committed_at, 'UTC')
WHERE committed_at <> date_trunc('milliseconds', committed_at, 'UTC');

UPDATE public.organization_creation_audit
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE public.organization_global_administrator_grants
SET end_at = date_trunc('milliseconds', end_at, 'UTC'),
  start_at = date_trunc('milliseconds', start_at, 'UTC')
WHERE end_at <> date_trunc('milliseconds', end_at, 'UTC')
  OR start_at <> date_trunc('milliseconds', start_at, 'UTC');

UPDATE public.organization_import_ledger
SET recorded_at = date_trunc('milliseconds', recorded_at, 'UTC')
WHERE recorded_at <> date_trunc('milliseconds', recorded_at, 'UTC');

UPDATE public.organization_lifecycle_history
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE public.organization_membership_quarantine
SET quarantined_at = date_trunc('milliseconds', quarantined_at, 'UTC')
WHERE quarantined_at <> date_trunc('milliseconds', quarantined_at, 'UTC');

UPDATE public.organization_memberships
SET end_at = date_trunc('milliseconds', end_at, 'UTC'),
  start_at = date_trunc('milliseconds', start_at, 'UTC')
WHERE end_at <> date_trunc('milliseconds', end_at, 'UTC')
  OR start_at <> date_trunc('milliseconds', start_at, 'UTC');

UPDATE public.organization_team_interest_registrations
SET submitted_at = date_trunc('milliseconds', submitted_at, 'UTC')
WHERE submitted_at <> date_trunc('milliseconds', submitted_at, 'UTC');

UPDATE public.organization_teams
SET deadline = date_trunc('milliseconds', deadline, 'UTC')
WHERE deadline <> date_trunc('milliseconds', deadline, 'UTC');

UPDATE public.organization_volunteer_affiliation_audit
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE public.profile_self_edit_commands
SET committed_at = date_trunc('milliseconds', committed_at, 'UTC')
WHERE committed_at <> date_trunc('milliseconds', committed_at, 'UTC');

UPDATE public.receipt_cohort_snapshots
SET recorded_at = date_trunc('milliseconds', recorded_at, 'UTC')
WHERE recorded_at <> date_trunc('milliseconds', recorded_at, 'UTC');

UPDATE public.recruitment_assignment_audit
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE public.recruitment_assignment_command_receipts
SET committed_at = date_trunc('milliseconds', committed_at, 'UTC')
WHERE committed_at <> date_trunc('milliseconds', committed_at, 'UTC');

UPDATE public.recruitment_interview_cancellations
SET cancelled_at = date_trunc('milliseconds', cancelled_at, 'UTC')
WHERE cancelled_at <> date_trunc('milliseconds', cancelled_at, 'UTC');

UPDATE public.recruitment_interview_completion_outbox
SET claimed_at = date_trunc('milliseconds', claimed_at, 'UTC'),
  delivered_at = date_trunc('milliseconds', delivered_at, 'UTC')
WHERE claimed_at <> date_trunc('milliseconds', claimed_at, 'UTC')
  OR delivered_at <> date_trunc('milliseconds', delivered_at, 'UTC');

UPDATE public.recruitment_interview_conducts
SET finalized_at = date_trunc('milliseconds', finalized_at, 'UTC')
WHERE finalized_at <> date_trunc('milliseconds', finalized_at, 'UTC');

UPDATE public.recruitment_interview_correction_assessments
SET corrected_at = date_trunc('milliseconds', corrected_at, 'UTC')
WHERE corrected_at <> date_trunc('milliseconds', corrected_at, 'UTC');

UPDATE public.recruitment_interview_correction_audit
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE public.recruitment_interview_correction_command_receipts
SET committed_at = date_trunc('milliseconds', committed_at, 'UTC')
WHERE committed_at <> date_trunc('milliseconds', committed_at, 'UTC');

UPDATE public.recruitment_interview_lifecycle_audit
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE public.recruitment_interview_lifecycle_command_receipts
SET committed_at = date_trunc('milliseconds', committed_at, 'UTC')
WHERE committed_at <> date_trunc('milliseconds', committed_at, 'UTC');

UPDATE public.recruitment_interview_schedules
SET committed_at = date_trunc('milliseconds', committed_at, 'UTC'),
  scheduled_at = date_trunc('milliseconds', scheduled_at, 'UTC')
WHERE committed_at <> date_trunc('milliseconds', committed_at, 'UTC')
  OR scheduled_at <> date_trunc('milliseconds', scheduled_at, 'UTC');

UPDATE public.recruitment_interviews
SET assigned_at = date_trunc('milliseconds', assigned_at, 'UTC')
WHERE assigned_at <> date_trunc('milliseconds', assigned_at, 'UTC');

UPDATE public.recruitment_invitation_outbox
SET claimed_at = date_trunc('milliseconds', claimed_at, 'UTC'),
  delivered_at = date_trunc('milliseconds', delivered_at, 'UTC')
WHERE claimed_at <> date_trunc('milliseconds', claimed_at, 'UTC')
  OR delivered_at <> date_trunc('milliseconds', delivered_at, 'UTC');

UPDATE public.recruitment_invitation_response_audit
SET responded_at = date_trunc('milliseconds', responded_at, 'UTC')
WHERE responded_at <> date_trunc('milliseconds', responded_at, 'UTC');

UPDATE public.recruitment_invitation_response_outbox
SET claimed_at = date_trunc('milliseconds', claimed_at, 'UTC'),
  delivered_at = date_trunc('milliseconds', delivered_at, 'UTC')
WHERE claimed_at <> date_trunc('milliseconds', claimed_at, 'UTC')
  OR delivered_at <> date_trunc('milliseconds', delivered_at, 'UTC');

UPDATE public.recruitment_invitations
SET created_at = date_trunc('milliseconds', created_at, 'UTC'),
  responded_at = date_trunc('milliseconds', responded_at, 'UTC'),
  superseded_at = date_trunc('milliseconds', superseded_at, 'UTC')
WHERE created_at <> date_trunc('milliseconds', created_at, 'UTC')
  OR responded_at <> date_trunc('milliseconds', responded_at, 'UTC')
  OR superseded_at <> date_trunc('milliseconds', superseded_at, 'UTC');

UPDATE public.recruitment_questionnaire_history
SET recorded_at = date_trunc('milliseconds', recorded_at, 'UTC')
WHERE recorded_at <> date_trunc('milliseconds', recorded_at, 'UTC');

UPDATE public.recruitment_schedule_audit
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE public.recruitment_schedule_command_receipts
SET committed_at = date_trunc('milliseconds', committed_at, 'UTC')
WHERE committed_at <> date_trunc('milliseconds', committed_at, 'UTC');

UPDATE public.recruitment_staffing_history
SET recorded_at = date_trunc('milliseconds', recorded_at, 'UTC')
WHERE recorded_at <> date_trunc('milliseconds', recorded_at, 'UTC');

UPDATE public.school_service_absences
SET reported_at = date_trunc('milliseconds', reported_at, 'UTC')
WHERE reported_at <> date_trunc('milliseconds', reported_at, 'UTC');

UPDATE public.school_service_audit
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE public.school_service_closures
SET closed_at = date_trunc('milliseconds', closed_at, 'UTC')
WHERE closed_at <> date_trunc('milliseconds', closed_at, 'UTC');

UPDATE public.school_service_commitments
SET created_at = date_trunc('milliseconds', created_at, 'UTC')
WHERE created_at <> date_trunc('milliseconds', created_at, 'UTC');

UPDATE public.school_service_coverage_acknowledgements
SET acknowledged_at = date_trunc('milliseconds', acknowledged_at, 'UTC')
WHERE acknowledged_at <> date_trunc('milliseconds', acknowledged_at, 'UTC');

UPDATE public.school_service_coverage_audit
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE public.school_service_decisions
SET decided_at = date_trunc('milliseconds', decided_at, 'UTC')
WHERE decided_at <> date_trunc('milliseconds', decided_at, 'UTC');

UPDATE public.school_service_dispatch_notification_outbox
SET claimed_at = date_trunc('milliseconds', claimed_at, 'UTC'),
  delivered_at = date_trunc('milliseconds', delivered_at, 'UTC')
WHERE claimed_at <> date_trunc('milliseconds', claimed_at, 'UTC')
  OR delivered_at <> date_trunc('milliseconds', delivered_at, 'UTC');

UPDATE public.school_service_notification_outbox
SET claimed_at = date_trunc('milliseconds', claimed_at, 'UTC'),
  delivered_at = date_trunc('milliseconds', delivered_at, 'UTC')
WHERE claimed_at <> date_trunc('milliseconds', claimed_at, 'UTC')
  OR delivered_at <> date_trunc('milliseconds', delivered_at, 'UTC');

UPDATE public.school_service_occurrences
SET recorded_at = date_trunc('milliseconds', recorded_at, 'UTC')
WHERE recorded_at <> date_trunc('milliseconds', recorded_at, 'UTC');

UPDATE public.school_service_proposals
SET confirmed_at = date_trunc('milliseconds', confirmed_at, 'UTC'),
  created_at = date_trunc('milliseconds', created_at, 'UTC')
WHERE confirmed_at <> date_trunc('milliseconds', confirmed_at, 'UTC')
  OR created_at <> date_trunc('milliseconds', created_at, 'UTC');

UPDATE public.school_service_substitute_offer_responses
SET responded_at = date_trunc('milliseconds', responded_at, 'UTC')
WHERE responded_at <> date_trunc('milliseconds', responded_at, 'UTC');

UPDATE public.school_service_substitute_offer_withdrawals
SET withdrawn_at = date_trunc('milliseconds', withdrawn_at, 'UTC')
WHERE withdrawn_at <> date_trunc('milliseconds', withdrawn_at, 'UTC');

UPDATE public.school_service_substitute_offers
SET dispatched_at = date_trunc('milliseconds', dispatched_at, 'UTC')
WHERE dispatched_at <> date_trunc('milliseconds', dispatched_at, 'UTC');

UPDATE public.school_survey_audit
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE public.school_survey_responses
SET submitted_at = date_trunc('milliseconds', submitted_at, 'UTC')
WHERE submitted_at <> date_trunc('milliseconds', submitted_at, 'UTC');

UPDATE public.schools_administration_audit
SET recorded_at = date_trunc('milliseconds', recorded_at, 'UTC')
WHERE recorded_at <> date_trunc('milliseconds', recorded_at, 'UTC');

UPDATE public.service_principal_grant_audit
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE public.service_principal_grants
SET created_at = date_trunc('milliseconds', created_at, 'UTC'),
  end_at = date_trunc('milliseconds', end_at, 'UTC'),
  revoked_at = date_trunc('milliseconds', revoked_at, 'UTC'),
  start_at = date_trunc('milliseconds', start_at, 'UTC'),
  updated_at = date_trunc('milliseconds', updated_at, 'UTC')
WHERE created_at <> date_trunc('milliseconds', created_at, 'UTC')
  OR end_at <> date_trunc('milliseconds', end_at, 'UTC')
  OR revoked_at <> date_trunc('milliseconds', revoked_at, 'UTC')
  OR start_at <> date_trunc('milliseconds', start_at, 'UTC')
  OR updated_at <> date_trunc('milliseconds', updated_at, 'UTC');

UPDATE public.service_principals
SET created_at = date_trunc('milliseconds', created_at, 'UTC'),
  updated_at = date_trunc('milliseconds', updated_at, 'UTC')
WHERE created_at <> date_trunc('milliseconds', created_at, 'UTC')
  OR updated_at <> date_trunc('milliseconds', updated_at, 'UTC');

UPDATE public.social_event_audit
SET occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE public.social_event_command_receipts
SET committed_at = date_trunc('milliseconds', committed_at, 'UTC')
WHERE committed_at <> date_trunc('milliseconds', committed_at, 'UTC');

UPDATE public.social_events
SET end_at = date_trunc('milliseconds', end_at, 'UTC'),
  start_at = date_trunc('milliseconds', start_at, 'UTC')
WHERE end_at <> date_trunc('milliseconds', end_at, 'UTC')
  OR start_at <> date_trunc('milliseconds', start_at, 'UTC');

UPDATE public.team_application_audit
SET deadline_after = date_trunc('milliseconds', deadline_after, 'UTC'),
  deadline_before = date_trunc('milliseconds', deadline_before, 'UTC'),
  occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')
WHERE deadline_after <> date_trunc('milliseconds', deadline_after, 'UTC')
  OR deadline_before <> date_trunc('milliseconds', deadline_before, 'UTC')
  OR occurred_at <> date_trunc('milliseconds', occurred_at, 'UTC');

UPDATE public.team_application_command_receipts
SET committed_at = date_trunc('milliseconds', committed_at, 'UTC')
WHERE committed_at <> date_trunc('milliseconds', committed_at, 'UTC');

UPDATE public.team_application_outbox
SET claimed_at = date_trunc('milliseconds', claimed_at, 'UTC'),
  committed_at = date_trunc('milliseconds', committed_at, 'UTC')
WHERE claimed_at <> date_trunc('milliseconds', claimed_at, 'UTC')
  OR committed_at <> date_trunc('milliseconds', committed_at, 'UTC');

UPDATE public.team_applications
SET submitted_at = date_trunc('milliseconds', submitted_at, 'UTC')
WHERE submitted_at <> date_trunc('milliseconds', submitted_at, 'UTC');

-- Two deferred foreign keys include an instant on both sides. Checking them now, after both
-- sides are truncated, clears their pending trigger events, which would otherwise block ALTER TABLE.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE auth.account
  ENABLE TRIGGER account_access_write,
  ALTER COLUMN "createdAt" SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS account_access_token_expires_at_ms,
  ADD CONSTRAINT account_access_token_expires_at_ms CHECK ("accessTokenExpiresAt" = date_trunc('milliseconds', "accessTokenExpiresAt", 'UTC')),
  DROP CONSTRAINT IF EXISTS account_created_at_ms,
  ADD CONSTRAINT account_created_at_ms CHECK ("createdAt" = date_trunc('milliseconds', "createdAt", 'UTC')),
  DROP CONSTRAINT IF EXISTS account_refresh_token_expires_at_ms,
  ADD CONSTRAINT account_refresh_token_expires_at_ms CHECK ("refreshTokenExpiresAt" = date_trunc('milliseconds', "refreshTokenExpiresAt", 'UTC')),
  DROP CONSTRAINT IF EXISTS account_updated_at_ms,
  ADD CONSTRAINT account_updated_at_ms CHECK ("updatedAt" = date_trunc('milliseconds', "updatedAt", 'UTC'));

ALTER TABLE auth.identity_security_audit
  ENABLE TRIGGER identity_security_audit_append_only,
  ALTER COLUMN occurred_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS identity_security_audit_occurred_at_ms,
  ADD CONSTRAINT identity_security_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE auth.jwks
  DROP CONSTRAINT IF EXISTS jwks_created_at_ms,
  ADD CONSTRAINT jwks_created_at_ms CHECK ("createdAt" = date_trunc('milliseconds', "createdAt", 'UTC')),
  DROP CONSTRAINT IF EXISTS jwks_expires_at_ms,
  ADD CONSTRAINT jwks_expires_at_ms CHECK ("expiresAt" = date_trunc('milliseconds', "expiresAt", 'UTC'));

ALTER TABLE auth."oauthAccessToken"
  DROP CONSTRAINT IF EXISTS oauthAccessToken_created_at_ms,
  ADD CONSTRAINT oauthAccessToken_created_at_ms CHECK ("createdAt" = date_trunc('milliseconds', "createdAt", 'UTC')),
  DROP CONSTRAINT IF EXISTS oauthAccessToken_expires_at_ms,
  ADD CONSTRAINT oauthAccessToken_expires_at_ms CHECK ("expiresAt" = date_trunc('milliseconds', "expiresAt", 'UTC')),
  DROP CONSTRAINT IF EXISTS oauthAccessToken_revoked_ms,
  ADD CONSTRAINT oauthAccessToken_revoked_ms CHECK (revoked = date_trunc('milliseconds', revoked, 'UTC'));

ALTER TABLE auth."oauthClient"
  DROP CONSTRAINT IF EXISTS oauthClient_created_at_ms,
  ADD CONSTRAINT oauthClient_created_at_ms CHECK ("createdAt" = date_trunc('milliseconds', "createdAt", 'UTC')),
  DROP CONSTRAINT IF EXISTS oauthClient_updated_at_ms,
  ADD CONSTRAINT oauthClient_updated_at_ms CHECK ("updatedAt" = date_trunc('milliseconds', "updatedAt", 'UTC'));

ALTER TABLE auth."oauthClientAssertion"
  DROP CONSTRAINT IF EXISTS oauthClientAssertion_expires_at_ms,
  ADD CONSTRAINT oauthClientAssertion_expires_at_ms CHECK ("expiresAt" = date_trunc('milliseconds', "expiresAt", 'UTC'));

ALTER TABLE auth."oauthClientResource"
  DROP CONSTRAINT IF EXISTS oauthClientResource_created_at_ms,
  ADD CONSTRAINT oauthClientResource_created_at_ms CHECK ("createdAt" = date_trunc('milliseconds', "createdAt", 'UTC'));

ALTER TABLE auth."oauthConsent"
  DROP CONSTRAINT IF EXISTS oauthConsent_created_at_ms,
  ADD CONSTRAINT oauthConsent_created_at_ms CHECK ("createdAt" = date_trunc('milliseconds', "createdAt", 'UTC')),
  DROP CONSTRAINT IF EXISTS oauthConsent_updated_at_ms,
  ADD CONSTRAINT oauthConsent_updated_at_ms CHECK ("updatedAt" = date_trunc('milliseconds', "updatedAt", 'UTC'));

ALTER TABLE auth."oauthRefreshToken"
  DROP CONSTRAINT IF EXISTS oauthRefreshToken_auth_time_ms,
  ADD CONSTRAINT oauthRefreshToken_auth_time_ms CHECK ("authTime" = date_trunc('milliseconds', "authTime", 'UTC')),
  DROP CONSTRAINT IF EXISTS oauthRefreshToken_created_at_ms,
  ADD CONSTRAINT oauthRefreshToken_created_at_ms CHECK ("createdAt" = date_trunc('milliseconds', "createdAt", 'UTC')),
  DROP CONSTRAINT IF EXISTS oauthRefreshToken_expires_at_ms,
  ADD CONSTRAINT oauthRefreshToken_expires_at_ms CHECK ("expiresAt" = date_trunc('milliseconds', "expiresAt", 'UTC')),
  DROP CONSTRAINT IF EXISTS oauthRefreshToken_revoked_ms,
  ADD CONSTRAINT oauthRefreshToken_revoked_ms CHECK (revoked = date_trunc('milliseconds', revoked, 'UTC')),
  DROP CONSTRAINT IF EXISTS oauthRefreshToken_rotated_at_ms,
  ADD CONSTRAINT oauthRefreshToken_rotated_at_ms CHECK ("rotatedAt" = date_trunc('milliseconds', "rotatedAt", 'UTC')),
  DROP CONSTRAINT IF EXISTS oauthRefreshToken_rotation_replay_expires_at_ms,
  ADD CONSTRAINT oauthRefreshToken_rotation_replay_expires_at_ms CHECK ("rotationReplayExpiresAt" = date_trunc('milliseconds', "rotationReplayExpiresAt", 'UTC'));

ALTER TABLE auth."oauthResource"
  DROP CONSTRAINT IF EXISTS oauthResource_created_at_ms,
  ADD CONSTRAINT oauthResource_created_at_ms CHECK ("createdAt" = date_trunc('milliseconds', "createdAt", 'UTC')),
  DROP CONSTRAINT IF EXISTS oauthResource_updated_at_ms,
  ADD CONSTRAINT oauthResource_updated_at_ms CHECK ("updatedAt" = date_trunc('milliseconds', "updatedAt", 'UTC'));

ALTER TABLE auth.oauth_access_token_state
  DROP CONSTRAINT IF EXISTS oauth_access_token_state_expires_at_ms,
  ADD CONSTRAINT oauth_access_token_state_expires_at_ms CHECK (expires_at = date_trunc('milliseconds', expires_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS oauth_access_token_state_issued_at_ms,
  ADD CONSTRAINT oauth_access_token_state_issued_at_ms CHECK (issued_at = date_trunc('milliseconds', issued_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS oauth_access_token_state_revoked_at_ms,
  ADD CONSTRAINT oauth_access_token_state_revoked_at_ms CHECK (revoked_at = date_trunc('milliseconds', revoked_at, 'UTC'));

ALTER TABLE auth.oauth_client_bindings
  ALTER COLUMN created_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  ALTER COLUMN updated_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS oauth_client_bindings_created_at_ms,
  ADD CONSTRAINT oauth_client_bindings_created_at_ms CHECK (created_at = date_trunc('milliseconds', created_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS oauth_client_bindings_secret_expires_at_ms,
  ADD CONSTRAINT oauth_client_bindings_secret_expires_at_ms CHECK (secret_expires_at = date_trunc('milliseconds', secret_expires_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS oauth_client_bindings_updated_at_ms,
  ADD CONSTRAINT oauth_client_bindings_updated_at_ms CHECK (updated_at = date_trunc('milliseconds', updated_at, 'UTC'));

ALTER TABLE auth.oauth_refresh_families
  DROP CONSTRAINT IF EXISTS oauth_refresh_families_absolute_expires_at_ms,
  ADD CONSTRAINT oauth_refresh_families_absolute_expires_at_ms CHECK (absolute_expires_at = date_trunc('milliseconds', absolute_expires_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS oauth_refresh_families_created_at_ms,
  ADD CONSTRAINT oauth_refresh_families_created_at_ms CHECK (created_at = date_trunc('milliseconds', created_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS oauth_refresh_families_inactivity_expires_at_ms,
  ADD CONSTRAINT oauth_refresh_families_inactivity_expires_at_ms CHECK (inactivity_expires_at = date_trunc('milliseconds', inactivity_expires_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS oauth_refresh_families_last_used_at_ms,
  ADD CONSTRAINT oauth_refresh_families_last_used_at_ms CHECK (last_used_at = date_trunc('milliseconds', last_used_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS oauth_refresh_families_revoked_at_ms,
  ADD CONSTRAINT oauth_refresh_families_revoked_at_ms CHECK (revoked_at = date_trunc('milliseconds', revoked_at, 'UTC'));

ALTER TABLE auth.oauth_security_audit
  ENABLE TRIGGER oauth_security_audit_no_update,
  DROP CONSTRAINT IF EXISTS oauth_security_audit_occurred_at_ms,
  ADD CONSTRAINT oauth_security_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE auth.password_reset_email_outbox
  ALTER COLUMN created_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS password_reset_email_outbox_claimed_at_ms,
  ADD CONSTRAINT password_reset_email_outbox_claimed_at_ms CHECK (claimed_at = date_trunc('milliseconds', claimed_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS password_reset_email_outbox_created_at_ms,
  ADD CONSTRAINT password_reset_email_outbox_created_at_ms CHECK (created_at = date_trunc('milliseconds', created_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS password_reset_email_outbox_delivered_at_ms,
  ADD CONSTRAINT password_reset_email_outbox_delivered_at_ms CHECK (delivered_at = date_trunc('milliseconds', delivered_at, 'UTC'));

ALTER TABLE auth.session
  ENABLE TRIGGER session_access_renewal,
  ALTER COLUMN "createdAt" SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS session_created_at_ms,
  ADD CONSTRAINT session_created_at_ms CHECK ("createdAt" = date_trunc('milliseconds', "createdAt", 'UTC')),
  DROP CONSTRAINT IF EXISTS session_expires_at_ms,
  ADD CONSTRAINT session_expires_at_ms CHECK ("expiresAt" = date_trunc('milliseconds', "expiresAt", 'UTC')),
  DROP CONSTRAINT IF EXISTS session_updated_at_ms,
  ADD CONSTRAINT session_updated_at_ms CHECK ("updatedAt" = date_trunc('milliseconds', "updatedAt", 'UTC'));

ALTER TABLE auth."user"
  ALTER COLUMN "createdAt" SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  ALTER COLUMN "updatedAt" SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS user_created_at_ms,
  ADD CONSTRAINT user_created_at_ms CHECK ("createdAt" = date_trunc('milliseconds', "createdAt", 'UTC')),
  DROP CONSTRAINT IF EXISTS user_updated_at_ms,
  ADD CONSTRAINT user_updated_at_ms CHECK ("updatedAt" = date_trunc('milliseconds', "updatedAt", 'UTC'));

ALTER TABLE auth.verification
  ALTER COLUMN "createdAt" SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  ALTER COLUMN "updatedAt" SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS verification_created_at_ms,
  ADD CONSTRAINT verification_created_at_ms CHECK ("createdAt" = date_trunc('milliseconds', "createdAt", 'UTC')),
  DROP CONSTRAINT IF EXISTS verification_expires_at_ms,
  ADD CONSTRAINT verification_expires_at_ms CHECK ("expiresAt" = date_trunc('milliseconds', "expiresAt", 'UTC')),
  DROP CONSTRAINT IF EXISTS verification_updated_at_ms,
  ADD CONSTRAINT verification_updated_at_ms CHECK ("updatedAt" = date_trunc('milliseconds', "updatedAt", 'UTC'));

ALTER TABLE public.admission_application_audit
  DROP CONSTRAINT IF EXISTS admission_application_audit_occurred_at_ms,
  ADD CONSTRAINT admission_application_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.admission_application_command_receipts
  DROP CONSTRAINT IF EXISTS admission_application_command_receipts_committed_at_ms,
  ADD CONSTRAINT admission_application_command_receipts_committed_at_ms CHECK (committed_at = date_trunc('milliseconds', committed_at, 'UTC'));

ALTER TABLE public.admission_application_outbox
  DROP CONSTRAINT IF EXISTS admission_application_outbox_claimed_at_ms,
  ADD CONSTRAINT admission_application_outbox_claimed_at_ms CHECK (claimed_at = date_trunc('milliseconds', claimed_at, 'UTC'));

ALTER TABLE public.admission_applications
  DROP CONSTRAINT IF EXISTS admission_applications_submitted_at_ms,
  ADD CONSTRAINT admission_applications_submitted_at_ms CHECK (submitted_at = date_trunc('milliseconds', submitted_at, 'UTC'));

ALTER TABLE public.admission_period_audit
  DROP CONSTRAINT IF EXISTS admission_period_audit_occurred_at_ms,
  ADD CONSTRAINT admission_period_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.admission_period_command_receipts
  DROP CONSTRAINT IF EXISTS admission_period_command_receipts_committed_at_ms,
  ADD CONSTRAINT admission_period_command_receipts_committed_at_ms CHECK (committed_at = date_trunc('milliseconds', committed_at, 'UTC'));

ALTER TABLE public.admission_period_outbox
  DROP CONSTRAINT IF EXISTS admission_period_outbox_claimed_at_ms,
  ADD CONSTRAINT admission_period_outbox_claimed_at_ms CHECK (claimed_at = date_trunc('milliseconds', claimed_at, 'UTC'));

ALTER TABLE public.admission_period_semesters
  ENABLE TRIGGER admission_period_semesters_http_revision,
  DROP CONSTRAINT IF EXISTS admission_period_semesters_end_at_ms,
  ADD CONSTRAINT admission_period_semesters_end_at_ms CHECK (end_at = date_trunc('milliseconds', end_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS admission_period_semesters_start_at_ms,
  ADD CONSTRAINT admission_period_semesters_start_at_ms CHECK (start_at = date_trunc('milliseconds', start_at, 'UTC'));

ALTER TABLE public.admission_periods
  DROP CONSTRAINT IF EXISTS admission_periods_end_at_ms,
  ADD CONSTRAINT admission_periods_end_at_ms CHECK (end_at = date_trunc('milliseconds', end_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS admission_periods_start_at_ms,
  ADD CONSTRAINT admission_periods_start_at_ms CHECK (start_at = date_trunc('milliseconds', start_at, 'UTC'));

ALTER TABLE public.admission_returning_command_receipts
  ENABLE TRIGGER admission_returning_registration_receipts_immutable,
  DROP CONSTRAINT IF EXISTS admission_returning_command_receipts_committed_at_ms,
  ADD CONSTRAINT admission_returning_command_receipts_committed_at_ms CHECK (committed_at = date_trunc('milliseconds', committed_at, 'UTC'));

ALTER TABLE public.admission_returning_registrations
  ENABLE TRIGGER admission_returning_registration_immutable,
  DROP CONSTRAINT IF EXISTS admission_returning_registrations_registered_at_ms,
  ADD CONSTRAINT admission_returning_registrations_registered_at_ms CHECK (registered_at = date_trunc('milliseconds', registered_at, 'UTC'));

ALTER TABLE public.applicant_account_audit
  ENABLE TRIGGER applicant_account_audit_immutable,
  DROP CONSTRAINT IF EXISTS applicant_account_audit_occurred_at_ms,
  ADD CONSTRAINT applicant_account_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.applicant_account_delivery
  ENABLE TRIGGER applicant_account_envelope_guard,
  DROP CONSTRAINT IF EXISTS applicant_account_delivery_claimed_at_ms,
  ADD CONSTRAINT applicant_account_delivery_claimed_at_ms CHECK (claimed_at = date_trunc('milliseconds', claimed_at, 'UTC'));

ALTER TABLE public.applicant_account_invitations
  ENABLE TRIGGER applicant_account_invitation_guard,
  DROP CONSTRAINT IF EXISTS applicant_account_invitations_expires_at_ms,
  ADD CONSTRAINT applicant_account_invitations_expires_at_ms CHECK (expires_at = date_trunc('milliseconds', expires_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS applicant_account_invitations_issued_at_ms,
  ADD CONSTRAINT applicant_account_invitations_issued_at_ms CHECK (issued_at = date_trunc('milliseconds', issued_at, 'UTC'));

ALTER TABLE public.applicant_account_links
  ENABLE TRIGGER applicant_account_link_immutable,
  DROP CONSTRAINT IF EXISTS applicant_account_links_linked_at_ms,
  ADD CONSTRAINT applicant_account_links_linked_at_ms CHECK (linked_at = date_trunc('milliseconds', linked_at, 'UTC'));

ALTER TABLE public.assistant_placement_audit
  DROP CONSTRAINT IF EXISTS assistant_placement_audit_occurred_at_ms,
  ADD CONSTRAINT assistant_placement_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.assistant_service_history
  ENABLE TRIGGER assistant_service_history_append_only,
  ALTER COLUMN imported_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS assistant_service_history_imported_at_ms,
  ADD CONSTRAINT assistant_service_history_imported_at_ms CHECK (imported_at = date_trunc('milliseconds', imported_at, 'UTC'));

ALTER TABLE public.authz_rules
  DROP CONSTRAINT IF EXISTS authz_rules_end_at_ms,
  ADD CONSTRAINT authz_rules_end_at_ms CHECK (end_at = date_trunc('milliseconds', end_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS authz_rules_start_at_ms,
  ADD CONSTRAINT authz_rules_start_at_ms CHECK (start_at = date_trunc('milliseconds', start_at, 'UTC'));

ALTER TABLE public.authz_tag_assignments
  DROP CONSTRAINT IF EXISTS authz_tag_assignments_end_at_ms,
  ADD CONSTRAINT authz_tag_assignments_end_at_ms CHECK (end_at = date_trunc('milliseconds', end_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS authz_tag_assignments_start_at_ms,
  ADD CONSTRAINT authz_tag_assignments_start_at_ms CHECK (start_at = date_trunc('milliseconds', start_at, 'UTC'));

ALTER TABLE public.contact_rate_windows
  DROP CONSTRAINT IF EXISTS contact_rate_windows_expires_at_ms,
  ADD CONSTRAINT contact_rate_windows_expires_at_ms CHECK (expires_at = date_trunc('milliseconds', expires_at, 'UTC'));

ALTER TABLE public.content_article_versions
  ENABLE RULE content_article_versions_no_update,
  DROP CONSTRAINT IF EXISTS content_article_versions_published_at_ms,
  ADD CONSTRAINT content_article_versions_published_at_ms CHECK (published_at = date_trunc('milliseconds', published_at, 'UTC'));

ALTER TABLE public.content_articles
  ALTER COLUMN created_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  ALTER COLUMN updated_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS content_articles_created_at_ms,
  ADD CONSTRAINT content_articles_created_at_ms CHECK (created_at = date_trunc('milliseconds', created_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS content_articles_updated_at_ms,
  ADD CONSTRAINT content_articles_updated_at_ms CHECK (updated_at = date_trunc('milliseconds', updated_at, 'UTC'));

ALTER TABLE public.content_publication_audit
  ENABLE TRIGGER content_publication_audit_immutable,
  DROP CONSTRAINT IF EXISTS content_publication_audit_occurred_at_ms,
  ADD CONSTRAINT content_publication_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.content_publication_command_receipts
  DROP CONSTRAINT IF EXISTS content_publication_command_receipts_committed_at_ms,
  ADD CONSTRAINT content_publication_command_receipts_committed_at_ms CHECK (committed_at = date_trunc('milliseconds', committed_at, 'UTC'));

ALTER TABLE public.current_assignment_imports
  ENABLE TRIGGER current_assignment_imports_append_only,
  ALTER COLUMN imported_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS current_assignment_imports_imported_at_ms,
  ADD CONSTRAINT current_assignment_imports_imported_at_ms CHECK (imported_at = date_trunc('milliseconds', imported_at, 'UTC'));

ALTER TABLE public.current_assignment_snapshots
  ENABLE TRIGGER current_assignment_snapshots_append_only,
  ALTER COLUMN imported_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS current_assignment_snapshots_imported_at_ms,
  ADD CONSTRAINT current_assignment_snapshots_imported_at_ms CHECK (imported_at = date_trunc('milliseconds', imported_at, 'UTC'));

ALTER TABLE public.economy_payment_authorities
  DROP CONSTRAINT IF EXISTS economy_payment_authorities_end_at_ms,
  ADD CONSTRAINT economy_payment_authorities_end_at_ms CHECK (end_at = date_trunc('milliseconds', end_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS economy_payment_authorities_start_at_ms,
  ADD CONSTRAINT economy_payment_authorities_start_at_ms CHECK (start_at = date_trunc('milliseconds', start_at, 'UTC'));

ALTER TABLE public.economy_receipt_approval_grants
  DROP CONSTRAINT IF EXISTS economy_receipt_approval_grants_end_at_ms,
  ADD CONSTRAINT economy_receipt_approval_grants_end_at_ms CHECK (end_at = date_trunc('milliseconds', end_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS economy_receipt_approval_grants_start_at_ms,
  ADD CONSTRAINT economy_receipt_approval_grants_start_at_ms CHECK (start_at = date_trunc('milliseconds', start_at, 'UTC'));

ALTER TABLE public.economy_receipt_audit
  DROP CONSTRAINT IF EXISTS economy_receipt_audit_occurred_at_ms,
  ADD CONSTRAINT economy_receipt_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.economy_receipt_command_receipts
  DROP CONSTRAINT IF EXISTS economy_receipt_command_receipts_committed_at_ms,
  ADD CONSTRAINT economy_receipt_command_receipts_committed_at_ms CHECK (committed_at = date_trunc('milliseconds', committed_at, 'UTC'));

ALTER TABLE public.economy_receipt_outbox
  ENABLE TRIGGER receipt_delivery_envelope_immutable,
  DROP CONSTRAINT IF EXISTS economy_receipt_outbox_claimed_at_ms,
  ADD CONSTRAINT economy_receipt_outbox_claimed_at_ms CHECK (claimed_at = date_trunc('milliseconds', claimed_at, 'UTC'));

ALTER TABLE public.economy_receipt_settlement_grants
  DROP CONSTRAINT IF EXISTS economy_receipt_settlement_grants_end_at_ms,
  ADD CONSTRAINT economy_receipt_settlement_grants_end_at_ms CHECK (end_at = date_trunc('milliseconds', end_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS economy_receipt_settlement_grants_start_at_ms,
  ADD CONSTRAINT economy_receipt_settlement_grants_start_at_ms CHECK (start_at = date_trunc('milliseconds', start_at, 'UTC'));

ALTER TABLE public.economy_receipt_settlements
  ENABLE TRIGGER economy_receipt_settlements_immutable,
  DROP CONSTRAINT IF EXISTS economy_receipt_settlements_recorded_at_ms,
  ADD CONSTRAINT economy_receipt_settlements_recorded_at_ms CHECK (recorded_at = date_trunc('milliseconds', recorded_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS economy_receipt_settlements_settled_at_ms,
  ADD CONSTRAINT economy_receipt_settlements_settled_at_ms CHECK (settled_at = date_trunc('milliseconds', settled_at, 'UTC'));

ALTER TABLE public.economy_receipts
  DROP CONSTRAINT IF EXISTS economy_receipts_approved_at_ms,
  ADD CONSTRAINT economy_receipts_approved_at_ms CHECK (approved_at = date_trunc('milliseconds', approved_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS economy_receipts_submitted_at_ms,
  ADD CONSTRAINT economy_receipts_submitted_at_ms CHECK (submitted_at = date_trunc('milliseconds', submitted_at, 'UTC'));

ALTER TABLE public.historical_service_reference_provenance
  ENABLE TRIGGER historical_service_reference_provenance_append_only,
  ALTER COLUMN imported_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS historical_service_reference_provenance_imported_at_ms,
  ADD CONSTRAINT historical_service_reference_provenance_imported_at_ms CHECK (imported_at = date_trunc('milliseconds', imported_at, 'UTC'));

ALTER TABLE public.historical_service_snapshots
  ENABLE TRIGGER historical_service_snapshots_append_only,
  ALTER COLUMN imported_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS historical_service_snapshots_imported_at_ms,
  ADD CONSTRAINT historical_service_snapshots_imported_at_ms CHECK (imported_at = date_trunc('milliseconds', imported_at, 'UTC'));

ALTER TABLE public.native_http_idempotency_receipts
  DROP CONSTRAINT IF EXISTS native_http_idempotency_receipts_committed_at_ms,
  ADD CONSTRAINT native_http_idempotency_receipts_committed_at_ms CHECK (committed_at = date_trunc('milliseconds', committed_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS native_http_idempotency_receipts_full_expires_at_ms,
  ADD CONSTRAINT native_http_idempotency_receipts_full_expires_at_ms CHECK (full_expires_at = date_trunc('milliseconds', full_expires_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS native_http_idempotency_receipts_tombstoned_at_ms,
  ADD CONSTRAINT native_http_idempotency_receipts_tombstoned_at_ms CHECK (tombstoned_at = date_trunc('milliseconds', tombstoned_at, 'UTC'));

ALTER TABLE public.native_survey_definitions
  ENABLE TRIGGER native_survey_definitions_school_lifecycle_guard,
  DROP CONSTRAINT IF EXISTS native_survey_definitions_closed_at_ms,
  ADD CONSTRAINT native_survey_definitions_closed_at_ms CHECK (closed_at = date_trunc('milliseconds', closed_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS native_survey_definitions_created_at_ms,
  ADD CONSTRAINT native_survey_definitions_created_at_ms CHECK (created_at = date_trunc('milliseconds', created_at, 'UTC'));

ALTER TABLE public.organization_cohort_snapshots
  ENABLE TRIGGER organization_cohort_snapshots_append_only,
  ALTER COLUMN recorded_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS organization_cohort_snapshots_recorded_at_ms,
  ADD CONSTRAINT organization_cohort_snapshots_recorded_at_ms CHECK (recorded_at = date_trunc('milliseconds', recorded_at, 'UTC'));

ALTER TABLE public.organization_command_receipts
  ENABLE TRIGGER organization_command_receipts_creation_links,
  DROP CONSTRAINT IF EXISTS organization_command_receipts_committed_at_ms,
  ADD CONSTRAINT organization_command_receipts_committed_at_ms CHECK (committed_at = date_trunc('milliseconds', committed_at, 'UTC'));

ALTER TABLE public.organization_creation_audit
  ENABLE TRIGGER organization_creation_audit_links,
  DROP CONSTRAINT IF EXISTS organization_creation_audit_occurred_at_ms,
  ADD CONSTRAINT organization_creation_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.organization_global_administrator_grants
  ENABLE TRIGGER organization_global_administrator_grants_profile_http_version,
  DROP CONSTRAINT IF EXISTS organization_global_administrator_grants_end_at_ms,
  ADD CONSTRAINT organization_global_administrator_grants_end_at_ms CHECK (end_at = date_trunc('milliseconds', end_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS organization_global_administrator_grants_start_at_ms,
  ADD CONSTRAINT organization_global_administrator_grants_start_at_ms CHECK (start_at = date_trunc('milliseconds', start_at, 'UTC'));

ALTER TABLE public.organization_import_ledger
  ALTER COLUMN recorded_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS organization_import_ledger_recorded_at_ms,
  ADD CONSTRAINT organization_import_ledger_recorded_at_ms CHECK (recorded_at = date_trunc('milliseconds', recorded_at, 'UTC'));

ALTER TABLE public.organization_lifecycle_history
  ENABLE TRIGGER organization_lifecycle_history_immutable,
  ALTER COLUMN occurred_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS organization_lifecycle_history_occurred_at_ms,
  ADD CONSTRAINT organization_lifecycle_history_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.organization_membership_quarantine
  ALTER COLUMN quarantined_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS organization_membership_quarantine_quarantined_at_ms,
  ADD CONSTRAINT organization_membership_quarantine_quarantined_at_ms CHECK (quarantined_at = date_trunc('milliseconds', quarantined_at, 'UTC'));

ALTER TABLE public.organization_memberships
  ENABLE TRIGGER organization_memberships_profile_http_version,
  DROP CONSTRAINT IF EXISTS organization_memberships_end_at_ms,
  ADD CONSTRAINT organization_memberships_end_at_ms CHECK (end_at = date_trunc('milliseconds', end_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS organization_memberships_start_at_ms,
  ADD CONSTRAINT organization_memberships_start_at_ms CHECK (start_at = date_trunc('milliseconds', start_at, 'UTC'));

ALTER TABLE public.organization_team_interest_registrations
  DROP CONSTRAINT IF EXISTS organization_team_interest_registrations_submitted_at_ms,
  ADD CONSTRAINT organization_team_interest_registrations_submitted_at_ms CHECK (submitted_at = date_trunc('milliseconds', submitted_at, 'UTC'));

ALTER TABLE public.organization_teams
  ENABLE TRIGGER organization_teams_creation_links,
  DROP CONSTRAINT IF EXISTS organization_teams_deadline_ms,
  ADD CONSTRAINT organization_teams_deadline_ms CHECK (deadline = date_trunc('milliseconds', deadline, 'UTC'));

ALTER TABLE public.organization_volunteer_affiliation_audit
  DROP CONSTRAINT IF EXISTS organization_volunteer_affiliation_audit_occurred_at_ms,
  ADD CONSTRAINT organization_volunteer_affiliation_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.profile_self_edit_commands
  ENABLE TRIGGER profile_self_edit_commands_immutable,
  ALTER COLUMN committed_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS profile_self_edit_commands_committed_at_ms,
  ADD CONSTRAINT profile_self_edit_commands_committed_at_ms CHECK (committed_at = date_trunc('milliseconds', committed_at, 'UTC'));

ALTER TABLE public.receipt_cohort_snapshots
  ENABLE TRIGGER receipt_cohort_snapshots_append_only,
  ALTER COLUMN recorded_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS receipt_cohort_snapshots_recorded_at_ms,
  ADD CONSTRAINT receipt_cohort_snapshots_recorded_at_ms CHECK (recorded_at = date_trunc('milliseconds', recorded_at, 'UTC'));

ALTER TABLE public.recruitment_assignment_audit
  DROP CONSTRAINT IF EXISTS recruitment_assignment_audit_occurred_at_ms,
  ADD CONSTRAINT recruitment_assignment_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.recruitment_assignment_command_receipts
  DROP CONSTRAINT IF EXISTS recruitment_assignment_command_receipts_committed_at_ms,
  ADD CONSTRAINT recruitment_assignment_command_receipts_committed_at_ms CHECK (committed_at = date_trunc('milliseconds', committed_at, 'UTC'));

ALTER TABLE public.recruitment_interview_cancellations
  ENABLE TRIGGER recruitment_interview_cancellations_immutable,
  DROP CONSTRAINT IF EXISTS recruitment_interview_cancellations_cancelled_at_ms,
  ADD CONSTRAINT recruitment_interview_cancellations_cancelled_at_ms CHECK (cancelled_at = date_trunc('milliseconds', cancelled_at, 'UTC'));

ALTER TABLE public.recruitment_interview_completion_outbox
  ENABLE TRIGGER recruitment_interview_completion_envelope_immutable,
  DROP CONSTRAINT IF EXISTS recruitment_interview_completion_outbox_claimed_at_ms,
  ADD CONSTRAINT recruitment_interview_completion_outbox_claimed_at_ms CHECK (claimed_at = date_trunc('milliseconds', claimed_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS recruitment_interview_completion_outbox_delivered_at_ms,
  ADD CONSTRAINT recruitment_interview_completion_outbox_delivered_at_ms CHECK (delivered_at = date_trunc('milliseconds', delivered_at, 'UTC'));

ALTER TABLE public.recruitment_interview_conducts
  ENABLE TRIGGER recruitment_interview_conducts_immutable,
  DROP CONSTRAINT IF EXISTS recruitment_interview_conducts_finalized_at_ms,
  ADD CONSTRAINT recruitment_interview_conducts_finalized_at_ms CHECK (finalized_at = date_trunc('milliseconds', finalized_at, 'UTC'));

ALTER TABLE public.recruitment_interview_correction_assessments
  ENABLE TRIGGER recruitment_interview_correction_assessments_immutable,
  DROP CONSTRAINT IF EXISTS recruitment_interview_correction_assessments_corrected_at_ms,
  ADD CONSTRAINT recruitment_interview_correction_assessments_corrected_at_ms CHECK (corrected_at = date_trunc('milliseconds', corrected_at, 'UTC'));

ALTER TABLE public.recruitment_interview_correction_audit
  ENABLE TRIGGER recruitment_interview_correction_audit_immutable,
  DROP CONSTRAINT IF EXISTS recruitment_interview_correction_audit_occurred_at_ms,
  ADD CONSTRAINT recruitment_interview_correction_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.recruitment_interview_correction_command_receipts
  ENABLE TRIGGER recruitment_interview_correction_receipts_immutable,
  DROP CONSTRAINT IF EXISTS recruitment_interview_correction_command_receip_committed_at_ms,
  ADD CONSTRAINT recruitment_interview_correction_command_receip_committed_at_ms CHECK (committed_at = date_trunc('milliseconds', committed_at, 'UTC'));

ALTER TABLE public.recruitment_interview_lifecycle_audit
  ENABLE TRIGGER recruitment_interview_lifecycle_audit_immutable,
  DROP CONSTRAINT IF EXISTS recruitment_interview_lifecycle_audit_occurred_at_ms,
  ADD CONSTRAINT recruitment_interview_lifecycle_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.recruitment_interview_lifecycle_command_receipts
  ENABLE TRIGGER recruitment_interview_lifecycle_command_receipts_immutable,
  DROP CONSTRAINT IF EXISTS recruitment_interview_lifecycle_command_receipt_committed_at_ms,
  ADD CONSTRAINT recruitment_interview_lifecycle_command_receipt_committed_at_ms CHECK (committed_at = date_trunc('milliseconds', committed_at, 'UTC'));

ALTER TABLE public.recruitment_interview_schedules
  ENABLE TRIGGER recruitment_interview_schedules_immutable,
  DROP CONSTRAINT IF EXISTS recruitment_interview_schedules_committed_at_ms,
  ADD CONSTRAINT recruitment_interview_schedules_committed_at_ms CHECK (committed_at = date_trunc('milliseconds', committed_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS recruitment_interview_schedules_scheduled_at_ms,
  ADD CONSTRAINT recruitment_interview_schedules_scheduled_at_ms CHECK (scheduled_at = date_trunc('milliseconds', scheduled_at, 'UTC'));

ALTER TABLE public.recruitment_interviews
  DROP CONSTRAINT IF EXISTS recruitment_interviews_assigned_at_ms,
  ADD CONSTRAINT recruitment_interviews_assigned_at_ms CHECK (assigned_at = date_trunc('milliseconds', assigned_at, 'UTC'));

ALTER TABLE public.recruitment_invitation_outbox
  DROP CONSTRAINT IF EXISTS recruitment_invitation_outbox_claimed_at_ms,
  ADD CONSTRAINT recruitment_invitation_outbox_claimed_at_ms CHECK (claimed_at = date_trunc('milliseconds', claimed_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS recruitment_invitation_outbox_delivered_at_ms,
  ADD CONSTRAINT recruitment_invitation_outbox_delivered_at_ms CHECK (delivered_at = date_trunc('milliseconds', delivered_at, 'UTC'));

ALTER TABLE public.recruitment_invitation_response_audit
  ENABLE TRIGGER recruitment_invitation_response_audit_immutable,
  ENABLE TRIGGER recruitment_invitation_response_audit_links,
  DROP CONSTRAINT IF EXISTS recruitment_invitation_response_audit_responded_at_ms,
  ADD CONSTRAINT recruitment_invitation_response_audit_responded_at_ms CHECK (responded_at = date_trunc('milliseconds', responded_at, 'UTC'));

ALTER TABLE public.recruitment_invitation_response_outbox
  ENABLE TRIGGER recruitment_invitation_response_outbox_links,
  ENABLE TRIGGER recruitment_invitation_response_outbox_request_immutable,
  DROP CONSTRAINT IF EXISTS recruitment_invitation_response_outbox_claimed_at_ms,
  ADD CONSTRAINT recruitment_invitation_response_outbox_claimed_at_ms CHECK (claimed_at = date_trunc('milliseconds', claimed_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS recruitment_invitation_response_outbox_delivered_at_ms,
  ADD CONSTRAINT recruitment_invitation_response_outbox_delivered_at_ms CHECK (delivered_at = date_trunc('milliseconds', delivered_at, 'UTC'));

ALTER TABLE public.recruitment_invitations
  ENABLE TRIGGER recruitment_invitations_response_links,
  DROP CONSTRAINT IF EXISTS recruitment_invitations_created_at_ms,
  ADD CONSTRAINT recruitment_invitations_created_at_ms CHECK (created_at = date_trunc('milliseconds', created_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS recruitment_invitations_responded_at_ms,
  ADD CONSTRAINT recruitment_invitations_responded_at_ms CHECK (responded_at = date_trunc('milliseconds', responded_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS recruitment_invitations_superseded_at_ms,
  ADD CONSTRAINT recruitment_invitations_superseded_at_ms CHECK (superseded_at = date_trunc('milliseconds', superseded_at, 'UTC'));

ALTER TABLE public.recruitment_questionnaire_history
  ENABLE TRIGGER recruitment_questionnaire_history_immutable,
  ALTER COLUMN recorded_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS recruitment_questionnaire_history_recorded_at_ms,
  ADD CONSTRAINT recruitment_questionnaire_history_recorded_at_ms CHECK (recorded_at = date_trunc('milliseconds', recorded_at, 'UTC'));

ALTER TABLE public.recruitment_schedule_audit
  DROP CONSTRAINT IF EXISTS recruitment_schedule_audit_occurred_at_ms,
  ADD CONSTRAINT recruitment_schedule_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.recruitment_schedule_command_receipts
  ENABLE TRIGGER recruitment_schedule_receipts_immutable,
  DROP CONSTRAINT IF EXISTS recruitment_schedule_command_receipts_committed_at_ms,
  ADD CONSTRAINT recruitment_schedule_command_receipts_committed_at_ms CHECK (committed_at = date_trunc('milliseconds', committed_at, 'UTC'));

ALTER TABLE public.recruitment_staffing_history
  ENABLE TRIGGER recruitment_staffing_history_immutable,
  ALTER COLUMN recorded_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS recruitment_staffing_history_recorded_at_ms,
  ADD CONSTRAINT recruitment_staffing_history_recorded_at_ms CHECK (recorded_at = date_trunc('milliseconds', recorded_at, 'UTC'));

ALTER TABLE public.school_service_absences
  ENABLE TRIGGER school_service_absence_immutable,
  DROP CONSTRAINT IF EXISTS school_service_absences_reported_at_ms,
  ADD CONSTRAINT school_service_absences_reported_at_ms CHECK (reported_at = date_trunc('milliseconds', reported_at, 'UTC'));

ALTER TABLE public.school_service_audit
  DROP CONSTRAINT IF EXISTS school_service_audit_occurred_at_ms,
  ADD CONSTRAINT school_service_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.school_service_closures
  ENABLE TRIGGER school_service_closure_immutable,
  DROP CONSTRAINT IF EXISTS school_service_closures_closed_at_ms,
  ADD CONSTRAINT school_service_closures_closed_at_ms CHECK (closed_at = date_trunc('milliseconds', closed_at, 'UTC'));

ALTER TABLE public.school_service_commitments
  ENABLE TRIGGER school_service_commitment_immutable,
  DROP CONSTRAINT IF EXISTS school_service_commitments_created_at_ms,
  ADD CONSTRAINT school_service_commitments_created_at_ms CHECK (created_at = date_trunc('milliseconds', created_at, 'UTC'));

ALTER TABLE public.school_service_coverage_acknowledgements
  ENABLE TRIGGER school_service_coverage_acknowledgement_immutable,
  DROP CONSTRAINT IF EXISTS school_service_coverage_acknowledgements_acknowledged_at_ms,
  ADD CONSTRAINT school_service_coverage_acknowledgements_acknowledged_at_ms CHECK (acknowledged_at = date_trunc('milliseconds', acknowledged_at, 'UTC'));

ALTER TABLE public.school_service_coverage_audit
  ENABLE TRIGGER school_service_coverage_audit_immutable,
  DROP CONSTRAINT IF EXISTS school_service_coverage_audit_occurred_at_ms,
  ADD CONSTRAINT school_service_coverage_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.school_service_decisions
  ENABLE TRIGGER school_service_decision_immutable,
  DROP CONSTRAINT IF EXISTS school_service_decisions_decided_at_ms,
  ADD CONSTRAINT school_service_decisions_decided_at_ms CHECK (decided_at = date_trunc('milliseconds', decided_at, 'UTC'));

ALTER TABLE public.school_service_dispatch_notification_outbox
  ENABLE TRIGGER school_service_dispatch_notification_guard,
  DROP CONSTRAINT IF EXISTS school_service_dispatch_notification_outbox_claimed_at_ms,
  ADD CONSTRAINT school_service_dispatch_notification_outbox_claimed_at_ms CHECK (claimed_at = date_trunc('milliseconds', claimed_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS school_service_dispatch_notification_outbox_delivered_at_ms,
  ADD CONSTRAINT school_service_dispatch_notification_outbox_delivered_at_ms CHECK (delivered_at = date_trunc('milliseconds', delivered_at, 'UTC'));

ALTER TABLE public.school_service_notification_outbox
  ENABLE TRIGGER school_service_notification_guard,
  DROP CONSTRAINT IF EXISTS school_service_notification_outbox_claimed_at_ms,
  ADD CONSTRAINT school_service_notification_outbox_claimed_at_ms CHECK (claimed_at = date_trunc('milliseconds', claimed_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS school_service_notification_outbox_delivered_at_ms,
  ADD CONSTRAINT school_service_notification_outbox_delivered_at_ms CHECK (delivered_at = date_trunc('milliseconds', delivered_at, 'UTC'));

ALTER TABLE public.school_service_occurrences
  ENABLE TRIGGER school_service_occurrence_immutable,
  DROP CONSTRAINT IF EXISTS school_service_occurrences_recorded_at_ms,
  ADD CONSTRAINT school_service_occurrences_recorded_at_ms CHECK (recorded_at = date_trunc('milliseconds', recorded_at, 'UTC'));

ALTER TABLE public.school_service_proposals
  ENABLE TRIGGER school_service_proposal_guard,
  DROP CONSTRAINT IF EXISTS school_service_proposals_confirmed_at_ms,
  ADD CONSTRAINT school_service_proposals_confirmed_at_ms CHECK (confirmed_at = date_trunc('milliseconds', confirmed_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS school_service_proposals_created_at_ms,
  ADD CONSTRAINT school_service_proposals_created_at_ms CHECK (created_at = date_trunc('milliseconds', created_at, 'UTC'));

ALTER TABLE public.school_service_substitute_offer_responses
  ENABLE TRIGGER school_service_substitute_offer_response_immutable,
  DROP CONSTRAINT IF EXISTS school_service_substitute_offer_responses_responded_at_ms,
  ADD CONSTRAINT school_service_substitute_offer_responses_responded_at_ms CHECK (responded_at = date_trunc('milliseconds', responded_at, 'UTC'));

ALTER TABLE public.school_service_substitute_offer_withdrawals
  ENABLE TRIGGER school_service_substitute_offer_withdrawal_immutable,
  DROP CONSTRAINT IF EXISTS school_service_substitute_offer_withdrawals_withdrawn_at_ms,
  ADD CONSTRAINT school_service_substitute_offer_withdrawals_withdrawn_at_ms CHECK (withdrawn_at = date_trunc('milliseconds', withdrawn_at, 'UTC'));

ALTER TABLE public.school_service_substitute_offers
  ENABLE TRIGGER school_service_offer_live_guard,
  ENABLE TRIGGER school_service_offer_reserve_person,
  ENABLE TRIGGER school_service_substitute_offer_guard,
  DROP CONSTRAINT IF EXISTS school_service_substitute_offers_dispatched_at_ms,
  ADD CONSTRAINT school_service_substitute_offers_dispatched_at_ms CHECK (dispatched_at = date_trunc('milliseconds', dispatched_at, 'UTC'));

ALTER TABLE public.school_survey_audit
  ENABLE TRIGGER school_survey_audit_guard,
  DROP CONSTRAINT IF EXISTS school_survey_audit_occurred_at_ms,
  ADD CONSTRAINT school_survey_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.school_survey_responses
  DROP CONSTRAINT IF EXISTS school_survey_responses_submitted_at_ms,
  ADD CONSTRAINT school_survey_responses_submitted_at_ms CHECK (submitted_at = date_trunc('milliseconds', submitted_at, 'UTC'));

ALTER TABLE public.schools_administration_audit
  ENABLE TRIGGER schools_administration_audit_immutable,
  ALTER COLUMN recorded_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS schools_administration_audit_recorded_at_ms,
  ADD CONSTRAINT schools_administration_audit_recorded_at_ms CHECK (recorded_at = date_trunc('milliseconds', recorded_at, 'UTC'));

ALTER TABLE public.service_principal_grant_audit
  ENABLE TRIGGER service_principal_grant_audit_no_update,
  DROP CONSTRAINT IF EXISTS service_principal_grant_audit_occurred_at_ms,
  ADD CONSTRAINT service_principal_grant_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.service_principal_grants
  ALTER COLUMN created_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  ALTER COLUMN updated_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS service_principal_grants_created_at_ms,
  ADD CONSTRAINT service_principal_grants_created_at_ms CHECK (created_at = date_trunc('milliseconds', created_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS service_principal_grants_end_at_ms,
  ADD CONSTRAINT service_principal_grants_end_at_ms CHECK (end_at = date_trunc('milliseconds', end_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS service_principal_grants_revoked_at_ms,
  ADD CONSTRAINT service_principal_grants_revoked_at_ms CHECK (revoked_at = date_trunc('milliseconds', revoked_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS service_principal_grants_start_at_ms,
  ADD CONSTRAINT service_principal_grants_start_at_ms CHECK (start_at = date_trunc('milliseconds', start_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS service_principal_grants_updated_at_ms,
  ADD CONSTRAINT service_principal_grants_updated_at_ms CHECK (updated_at = date_trunc('milliseconds', updated_at, 'UTC'));

ALTER TABLE public.service_principals
  ALTER COLUMN created_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  ALTER COLUMN updated_at SET DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  DROP CONSTRAINT IF EXISTS service_principals_created_at_ms,
  ADD CONSTRAINT service_principals_created_at_ms CHECK (created_at = date_trunc('milliseconds', created_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS service_principals_updated_at_ms,
  ADD CONSTRAINT service_principals_updated_at_ms CHECK (updated_at = date_trunc('milliseconds', updated_at, 'UTC'));

ALTER TABLE public.social_event_audit
  ENABLE TRIGGER social_event_audit_immutable,
  DROP CONSTRAINT IF EXISTS social_event_audit_occurred_at_ms,
  ADD CONSTRAINT social_event_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.social_event_command_receipts
  ENABLE TRIGGER social_event_command_receipts_immutable,
  DROP CONSTRAINT IF EXISTS social_event_command_receipts_committed_at_ms,
  ADD CONSTRAINT social_event_command_receipts_committed_at_ms CHECK (committed_at = date_trunc('milliseconds', committed_at, 'UTC'));

ALTER TABLE public.social_events
  DROP CONSTRAINT IF EXISTS social_events_end_at_ms,
  ADD CONSTRAINT social_events_end_at_ms CHECK (end_at = date_trunc('milliseconds', end_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS social_events_start_at_ms,
  ADD CONSTRAINT social_events_start_at_ms CHECK (start_at = date_trunc('milliseconds', start_at, 'UTC'));

ALTER TABLE public.team_application_audit
  DROP CONSTRAINT IF EXISTS team_application_audit_deadline_after_ms,
  ADD CONSTRAINT team_application_audit_deadline_after_ms CHECK (deadline_after = date_trunc('milliseconds', deadline_after, 'UTC')),
  DROP CONSTRAINT IF EXISTS team_application_audit_deadline_before_ms,
  ADD CONSTRAINT team_application_audit_deadline_before_ms CHECK (deadline_before = date_trunc('milliseconds', deadline_before, 'UTC')),
  DROP CONSTRAINT IF EXISTS team_application_audit_occurred_at_ms,
  ADD CONSTRAINT team_application_audit_occurred_at_ms CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.team_application_command_receipts
  DROP CONSTRAINT IF EXISTS team_application_command_receipts_committed_at_ms,
  ADD CONSTRAINT team_application_command_receipts_committed_at_ms CHECK (committed_at = date_trunc('milliseconds', committed_at, 'UTC'));

ALTER TABLE public.team_application_outbox
  ENABLE TRIGGER team_application_outbox_guard,
  DROP CONSTRAINT IF EXISTS team_application_outbox_claimed_at_ms,
  ADD CONSTRAINT team_application_outbox_claimed_at_ms CHECK (claimed_at = date_trunc('milliseconds', claimed_at, 'UTC')),
  DROP CONSTRAINT IF EXISTS team_application_outbox_committed_at_ms,
  ADD CONSTRAINT team_application_outbox_committed_at_ms CHECK (committed_at = date_trunc('milliseconds', committed_at, 'UTC'));

ALTER TABLE public.team_applications
  DROP CONSTRAINT IF EXISTS team_applications_submitted_at_ms,
  ADD CONSTRAINT team_applications_submitted_at_ms CHECK (submitted_at = date_trunc('milliseconds', submitted_at, 'UTC'));
