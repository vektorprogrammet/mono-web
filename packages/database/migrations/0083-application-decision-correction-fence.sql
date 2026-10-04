-- Decisions, corrections, and onboarding share the application-owned, versioned fence.
-- Updating the version is essential: FOR UPDATE alone cannot invalidate a pre-decision
-- REPEATABLE READ snapshot. PostgreSQL refuses that old writer with SQLSTATE 40001.
ALTER TABLE public.admission_applications ADD COLUMN decision_fence_version bigint NOT NULL DEFAULT 0;
CREATE FUNCTION public.fence_application_decision(application text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.admission_applications SET decision_fence_version=decision_fence_version+1
    WHERE application_id=application;
  IF NOT FOUND THEN RAISE EXCEPTION 'Application decision fence not found'; END IF;
END $$;

CREATE TABLE public.application_admission_decision_evidence (
  application_id text PRIMARY KEY REFERENCES public.admission_applications(application_id),
  basis text NOT NULL CHECK(basis IN ('Ja','Kanskje','Nei','Returning','Unreviewed')),
  outcome text NOT NULL CHECK(outcome IN ('Admitted','Rejected')),
  interview_id text REFERENCES public.recruitment_interviews(interview_id),
  assessment_revision integer,
  interview_completed boolean NOT NULL,
  interview_cancelled boolean NOT NULL,
  returning_registered boolean NOT NULL,
  citation_state text NOT NULL CHECK(citation_state IN ('Cited','Unavailable')),
  closed_at timestamptz NOT NULL,
  CHECK ((citation_state='Unavailable') = (basis='Unreviewed')),
  CHECK (assessment_revision IS NULL OR interview_id IS NOT NULL)
);
-- Historical revisions never cited an assessment. Do not invent their citation from
-- today's effective view. Preserve the terminal announcement or latest recorded outcome.
INSERT INTO public.application_admission_decision_evidence
(application_id,basis,outcome,interview_completed,interview_cancelled,returning_registered,citation_state,closed_at)
SELECT latest.application_id,'Unreviewed',COALESCE(announcement.outcome,latest.outcome),false,false,false,'Unavailable',
  COALESCE(announcement.announced_at,latest.decided_at)
FROM public.admission_application_outcomes latest
LEFT JOIN public.admission_outcome_announcements announcement USING(application_id)
WHERE latest.revision=(SELECT max(revision) FROM public.admission_application_outcomes x WHERE x.application_id=latest.application_id);
CREATE TRIGGER admission_decision_evidence_immutable BEFORE UPDATE OR DELETE ON public.application_admission_decision_evidence
FOR EACH ROW EXECUTE FUNCTION public.freeze_recruitment_maintenance_evidence();

-- ONE evidence projection. Public outcome boards, closure citations, and standing readers
-- all consume this view, never separate recommendation CASE expressions.
CREATE VIEW public.application_admission_evidence AS
SELECT a.application_id,a.admission_period_id,p.department_id,p.semester_id,
  p.start_at AS period_opens_at,p.end_at AS period_closes_at,
  s.start_at AS semester_starts_at,s.end_at AS semester_ends_at,
  CASE WHEN frozen.application_id IS NOT NULL THEN frozen.basis
    WHEN live.interview_completed AND NOT live.interview_cancelled AND live.recommendation IS NOT NULL THEN live.recommendation
    WHEN live.returning_registered THEN 'Returning' ELSE 'Unreviewed' END AS basis,
  CASE WHEN announcement.application_id IS NOT NULL THEN announcement.outcome
    WHEN frozen.application_id IS NOT NULL THEN current.outcome
    WHEN live.interview_completed AND NOT live.interview_cancelled AND live.recommendation='Ja' THEN 'Admitted'
    WHEN live.interview_completed AND NOT live.interview_cancelled AND live.recommendation='Nei' THEN 'Rejected'
    ELSE current.outcome END AS outcome,
  frozen.application_id IS NOT NULL AS decision_closed,
  CASE WHEN frozen.application_id IS NOT NULL THEN frozen.interview_completed ELSE live.interview_completed END AS interview_completed,
  CASE WHEN frozen.application_id IS NOT NULL THEN frozen.interview_cancelled ELSE live.interview_cancelled END AS interview_cancelled,
  CASE WHEN frozen.application_id IS NOT NULL THEN frozen.returning_registered ELSE live.returning_registered END AS returning_registered,
  link.person_id AS linked_person_id,
  CASE WHEN frozen.application_id IS NOT NULL THEN frozen.interview_id ELSE live.interview_id END AS interview_id,
  CASE WHEN frozen.application_id IS NOT NULL THEN frozen.assessment_revision ELSE live.effective_revision END AS assessment_revision,
  COALESCE(frozen.citation_state,'Cited') AS citation_state
FROM public.admission_applications a
JOIN public.admission_periods p ON p.admission_period_id=a.admission_period_id AND p.department_id=a.department_id
JOIN public.admission_period_semesters s USING(semester_id)
LEFT JOIN public.applicant_account_links link USING(applicant_id)
LEFT JOIN public.application_admission_decision_evidence frozen USING(application_id)
LEFT JOIN public.admission_outcome_announcements announcement USING(application_id)
LEFT JOIN LATERAL (SELECT outcome FROM public.admission_application_outcomes o WHERE o.application_id=a.application_id ORDER BY revision DESC LIMIT 1) current ON true
LEFT JOIN LATERAL (
  SELECT i.interview_id,assessment.recommendation,assessment.effective_revision,
    assessment.interview_id IS NOT NULL AS interview_completed,
    EXISTS(SELECT 1 FROM public.recruitment_interview_cancellations c WHERE c.interview_id=i.interview_id) AS interview_cancelled,
    EXISTS(SELECT 1 FROM public.admission_returning_registrations r WHERE r.application_id=a.application_id) AS returning_registered
  FROM (SELECT 1) singleton LEFT JOIN public.recruitment_interviews i ON i.application_id=a.application_id
  LEFT JOIN public.recruitment_interview_effective_assessments assessment ON assessment.interview_id=i.interview_id
) live ON true;

CREATE TABLE public.recruitment_assessment_correction_windows (
  interview_id text NOT NULL REFERENCES public.recruitment_interviews(interview_id),
  sequence integer NOT NULL CHECK(sequence>0),
  opened_by text NOT NULL REFERENCES public.person_profiles(person_id),
  opened_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  closed_by text REFERENCES public.person_profiles(person_id),
  closed_at timestamptz,
  reason text NOT NULL CHECK(char_length(btrim(reason)) BETWEEN 1 AND 2000),
  close_reason text,
  PRIMARY KEY(interview_id,sequence),
  CHECK(opened_at<ends_at),
  CHECK((closed_at IS NULL)=(closed_by IS NULL)),
  CHECK((closed_at IS NULL)=(close_reason IS NULL)),
  CHECK(closed_at IS NULL OR (opened_at<=closed_at AND closed_at<ends_at)),
  CHECK(close_reason IS NULL OR char_length(btrim(close_reason)) BETWEEN 1 AND 2000)
);
CREATE TABLE public.recruitment_assessment_correction_window_audit (
  actor_person_id text NOT NULL,
  command_id text NOT NULL,
  interview_id text NOT NULL,
  sequence integer NOT NULL,
  action text NOT NULL CHECK(action IN ('Reopen','Close')),
  reason text NOT NULL CHECK(char_length(btrim(reason)) BETWEEN 1 AND 2000),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY(actor_person_id,command_id),
  FOREIGN KEY(actor_person_id,command_id) REFERENCES public.recruitment_maintenance_command_receipts(actor_person_id,command_id),
  FOREIGN KEY(interview_id,sequence) REFERENCES public.recruitment_assessment_correction_windows(interview_id,sequence)
);
CREATE TRIGGER assessment_correction_window_audit_immutable BEFORE UPDATE OR DELETE ON public.recruitment_assessment_correction_window_audit
FOR EACH ROW EXECUTE FUNCTION public.freeze_recruitment_maintenance_evidence();

-- Common owner for every decision-sensitive write. Existing chain and finality
-- guards remain; this backstop runs first and gives them a current fenced snapshot.
CREATE FUNCTION public.guard_application_decision_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE application text; evidence record; correction_window record; semester_end timestamptz;
BEGIN
  IF TG_TABLE_NAME IN ('admission_application_outcomes','admission_outcome_announcements') THEN
    application:=NEW.application_id;
  ELSE
    SELECT application_id INTO application FROM public.recruitment_interviews WHERE interview_id=NEW.interview_id;
  END IF;
  PERFORM public.fence_application_decision(application);
  SELECT * INTO evidence FROM public.application_admission_evidence WHERE application_id=application;
  IF TG_TABLE_NAME='admission_application_outcomes' THEN
    IF evidence.decision_closed THEN
      IF evidence.citation_state<>'Cited' OR evidence.basis NOT IN ('Kanskje','Returning') OR NEW.provenance<>'Decision' THEN
        RAISE EXCEPTION 'Only an explicit decision using the same frozen basis may be revised';
      END IF;
    ELSIF evidence.basis IN ('Ja','Nei') THEN
      IF NEW.provenance<>'Recommendation' OR NEW.outcome<>evidence.outcome THEN RAISE EXCEPTION 'Derived outcome cannot be overridden'; END IF;
    ELSIF evidence.basis IN ('Kanskje','Returning') THEN
      IF NEW.provenance<>'Decision' THEN RAISE EXCEPTION 'An explicit decision is required'; END IF;
    ELSE RAISE EXCEPTION 'No cited evidence supports a new decision'; END IF;
    IF NOT evidence.decision_closed THEN
      INSERT INTO public.application_admission_decision_evidence
        (application_id,basis,outcome,interview_id,assessment_revision,interview_completed,interview_cancelled,returning_registered,citation_state,closed_at)
      VALUES(application,evidence.basis,NEW.outcome,evidence.interview_id,evidence.assessment_revision,
        evidence.interview_completed,evidence.interview_cancelled,evidence.returning_registered,'Cited',NEW.decided_at);
    END IF;
  ELSIF TG_TABLE_NAME='admission_outcome_announcements' THEN
    IF NEW.outcome IS DISTINCT FROM evidence.outcome THEN RAISE EXCEPTION 'Announcement must preserve frozen decision'; END IF;
  ELSIF TG_TABLE_NAME='recruitment_interview_correction_assessments' THEN
    IF NOT evidence.interview_completed OR evidence.interview_cancelled THEN RAISE EXCEPTION 'Correction requires completed uncancelled conduct'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.recruitment_interviews i WHERE i.interview_id=NEW.interview_id
      AND NEW.corrected_by_person_id IN (i.interviewer_person_id,i.co_interviewer_person_id))
      OR NEW.corrected_by_person_id IS NOT DISTINCT FROM evidence.linked_person_id THEN
      RAISE EXCEPTION 'Only a non-self assigned interviewer can correct';
    END IF;
    IF evidence.decision_closed THEN
      SELECT * INTO correction_window FROM public.recruitment_assessment_correction_windows w WHERE w.interview_id=NEW.interview_id ORDER BY sequence DESC LIMIT 1;
      IF correction_window IS NULL OR correction_window.closed_at IS NOT NULL OR correction_window.opened_by=NEW.corrected_by_person_id
        OR NEW.corrected_at<correction_window.opened_at OR NEW.corrected_at>=correction_window.ends_at THEN
        RAISE EXCEPTION 'A current independent correction window is required';
      END IF;
    END IF;
  ELSE
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Correction windows cannot be deleted'; END IF;
    IF NOT evidence.decision_closed OR NOT EXISTS(SELECT 1 FROM public.recruitment_interview_conducts WHERE interview_id=NEW.interview_id)
      OR EXISTS(SELECT 1 FROM public.recruitment_interview_cancellations WHERE interview_id=NEW.interview_id) THEN
      RAISE EXCEPTION 'Window requires closed decision and completed uncancelled interview';
    END IF;
    SELECT end_at INTO semester_end FROM public.admission_period_semesters WHERE semester_id=evidence.semester_id;
    IF NEW.ends_at>semester_end THEN RAISE EXCEPTION 'Window cannot outlive own semester'; END IF;
    IF TG_OP='INSERT' THEN
      SELECT * INTO correction_window FROM public.recruitment_assessment_correction_windows w WHERE w.interview_id=NEW.interview_id ORDER BY sequence DESC LIMIT 1;
      IF NEW.sequence<>COALESCE(correction_window.sequence,0)+1 OR NEW.closed_at IS NOT NULL
        OR (correction_window.closed_at IS NULL AND NEW.opened_at<correction_window.ends_at) THEN RAISE EXCEPTION 'Window sequence or overlap'; END IF;
    ELSE
      IF OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL
        OR (to_jsonb(NEW)-'closed_at'-'closed_by'-'close_reason')<>(to_jsonb(OLD)-'closed_at'-'closed_by'-'close_reason') THEN
        RAISE EXCEPTION 'Window permits only one early close';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_application_decision_fence BEFORE INSERT ON public.admission_application_outcomes
FOR EACH ROW EXECUTE FUNCTION public.guard_application_decision_write();
CREATE TRIGGER a_application_decision_fence BEFORE INSERT ON public.admission_outcome_announcements
FOR EACH ROW EXECUTE FUNCTION public.guard_application_decision_write();
CREATE TRIGGER a_application_decision_fence BEFORE INSERT ON public.recruitment_interview_correction_assessments
FOR EACH ROW EXECUTE FUNCTION public.guard_application_decision_write();
CREATE TRIGGER a_application_decision_fence BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_assessment_correction_windows
FOR EACH ROW EXECUTE FUNCTION public.guard_application_decision_write();
