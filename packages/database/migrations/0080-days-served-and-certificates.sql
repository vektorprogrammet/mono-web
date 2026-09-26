-- Days served and certificates (docs/system.md#certificates). School coordination confirms each
-- assistant's days served per department and semester; a correction appends the next revision and
-- keeps the earlier confirmation. Every certificate issue records who, when, under which seat,
-- and the hash of the content. Service facts are read, never changed.

-- The department grants the confirmation capability by delegation; the registry is
-- packages/domain/src/authz/delegation.ts.
ALTER TABLE public.organization_delegations
  DROP CONSTRAINT organization_delegations_capability_check,
  ADD CONSTRAINT organization_delegations_capability_check CHECK (capability IN (
    'admissions.periods', 'admissions.outcomes', 'recruitment.interviews', 'placements.coordinate',
    'placements.days-served', 'schools.administer', 'appointments.manage', 'people.read',
    'team-interest.read', 'content.publish', 'receipts.approve', 'receipts.settle'));

CREATE TABLE public.days_served_confirmations (
  confirmation_id text PRIMARY KEY
    CHECK (confirmation_id ~ '^days-served-confirmation-[a-f0-9]{64}$'),
  person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  department_id text NOT NULL REFERENCES public.organization_departments(department_id),
  semester_id text NOT NULL REFERENCES public.admission_period_semesters(semester_id),
  revision integer NOT NULL CHECK (revision >= 1),
  total integer NOT NULL CHECK (total BETWEEN 0 AND 366),
  calculated integer NOT NULL CHECK (calculated >= 0),
  -- The evidence that the confirmer saw; the certificate names its schools.
  evidence_json jsonb NOT NULL CHECK (jsonb_typeof(evidence_json) = 'object'),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  confirmed_at timestamptz NOT NULL,
  confirmed_by_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  CONSTRAINT days_served_confirmations_revision UNIQUE (person_id, department_id, semester_id, revision),
  CONSTRAINT days_served_confirmations_confirmed_at_ms
    CHECK (confirmed_at = date_trunc('milliseconds', confirmed_at, 'UTC'))
);

CREATE INDEX days_served_confirmations_department
  ON public.days_served_confirmations (department_id, person_id, semester_id, revision DESC);

-- A confirmation is the next revision of its assistant, department, and semester: no gap and no
-- second writer of one revision, so a correction never overwrites the confirmation before it.
CREATE FUNCTION public.guard_days_served_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision <> 1 + COALESCE((
    SELECT max(revision) FROM public.days_served_confirmations
    WHERE person_id = NEW.person_id AND department_id = NEW.department_id
      AND semester_id = NEW.semester_id), 0) THEN
    RAISE EXCEPTION 'A days-served confirmation must be the next revision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER days_served_confirmation_revision
  BEFORE INSERT ON public.days_served_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.guard_days_served_confirmation();

CREATE TABLE public.certificate_issues (
  issue_id text PRIMARY KEY CHECK (issue_id ~ '^certificate-issue-[a-f0-9]{64}$'),
  person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  department_id text NOT NULL REFERENCES public.organization_departments(department_id),
  content_json jsonb NOT NULL CHECK (jsonb_typeof(content_json) = 'object'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL,
  issued_by_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  issuer_name text NOT NULL CHECK (char_length(btrim(issuer_name)) BETWEEN 1 AND 250),
  seat_title text NOT NULL CHECK (char_length(btrim(seat_title)) BETWEEN 1 AND 600),
  issuer_basis text NOT NULL
    CHECK (issuer_basis IN ('BoardSeat', 'DerivedSeat', 'GlobalAdministrator')),
  -- Only issuers download a certificate; the assistant never issues their own.
  CONSTRAINT certificate_issues_not_own CHECK (issued_by_person_id <> person_id),
  CONSTRAINT certificate_issues_content_subject CHECK (
    content_json ->> 'personId' = person_id AND content_json ->> 'departmentId' = department_id),
  CONSTRAINT certificate_issues_issued_at_ms
    CHECK (issued_at = date_trunc('milliseconds', issued_at, 'UTC'))
);

CREATE INDEX certificate_issues_assistant
  ON public.certificate_issues (department_id, person_id, issued_at, issue_id);

CREATE FUNCTION public.certificate_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'days-served confirmations and certificate issues are append-only'; END $$;
CREATE TRIGGER days_served_confirmations_immutable
  BEFORE UPDATE OR DELETE ON public.days_served_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.certificate_history_immutable();
CREATE TRIGGER days_served_confirmations_truncate_immutable
  BEFORE TRUNCATE ON public.days_served_confirmations
  FOR EACH STATEMENT EXECUTE FUNCTION public.certificate_history_immutable();
CREATE TRIGGER certificate_issues_immutable
  BEFORE UPDATE OR DELETE ON public.certificate_issues
  FOR EACH ROW EXECUTE FUNCTION public.certificate_history_immutable();
CREATE TRIGGER certificate_issues_truncate_immutable
  BEFORE TRUNCATE ON public.certificate_issues
  FOR EACH STATEMENT EXECUTE FUNCTION public.certificate_history_immutable();
