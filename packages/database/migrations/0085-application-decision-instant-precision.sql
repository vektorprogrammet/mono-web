-- Migration 83 added decision and correction-window instants after migration 72's
-- millisecond boundary. Extend the same validated CHECK construction without
-- rewriting frozen citations, append-only audit, window bounds, or fence versions.
-- The Migrator commits these schema changes atomically. A historical microsecond
-- value aborts the upgrade with its violated constraint; it is never truncated.
-- These columns have no clock defaults: their instants are explicit command facts.

ALTER TABLE public.application_admission_decision_evidence
  ADD CONSTRAINT application_admission_decision_evidence_closed_at_ms
    CHECK (closed_at = date_trunc('milliseconds', closed_at, 'UTC'));

ALTER TABLE public.recruitment_assessment_correction_window_audit
  ADD CONSTRAINT recruitment_assessment_correction_window_audit_occurred_at_ms
    CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'));

ALTER TABLE public.recruitment_assessment_correction_windows
  ADD CONSTRAINT recruitment_assessment_correction_windows_closed_at_ms
    CHECK (closed_at = date_trunc('milliseconds', closed_at, 'UTC')),
  ADD CONSTRAINT recruitment_assessment_correction_windows_ends_at_ms
    CHECK (ends_at = date_trunc('milliseconds', ends_at, 'UTC')),
  ADD CONSTRAINT recruitment_assessment_correction_windows_opened_at_ms
    CHECK (opened_at = date_trunc('milliseconds', opened_at, 'UTC'));
