-- Standalone team applications. Intake settings remain Organization-owned
-- (organization_teams.accept_application, deadline, revision).

CREATE TABLE public.team_applications (
  application_id text PRIMARY KEY
    CONSTRAINT team_applications_id_uuid
    CHECK (application_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  team_id text NOT NULL REFERENCES public.organization_teams(team_id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  phone text NOT NULL CHECK (char_length(phone) BETWEEN 1 AND 40),
  year_of_study text NOT NULL CHECK (char_length(year_of_study) BETWEEN 1 AND 100),
  field_of_study text NOT NULL CHECK (char_length(field_of_study) BETWEEN 1 AND 45),
  biography text NOT NULL CHECK (char_length(biography) BETWEEN 1 AND 10000),
  motivation text NOT NULL CHECK (char_length(motivation) BETWEEN 1 AND 10000),
  submitted_at timestamptz NOT NULL
);

CREATE INDEX team_applications_team_newest
  ON public.team_applications (team_id, submitted_at DESC, application_id DESC);

-- Command receipts hold a request digest and a non-private observation only.
-- A submission receipt keeps the application and team identifiers after deletion.
CREATE TABLE public.team_application_command_receipts (
  command_id text PRIMARY KEY CHECK (char_length(command_id) BETWEEN 1 AND 128),
  command_sha256 text NOT NULL CHECK (command_sha256 ~ '^[a-f0-9]{64}$'),
  operation text NOT NULL CHECK (
    operation IN ('SubmitTeamApplication', 'DeleteTeamApplication', 'ReviseTeamApplicationIntake')
  ),
  team_id text NOT NULL REFERENCES public.organization_teams(team_id),
  application_id text NULL,
  observation_json jsonb NOT NULL CHECK (jsonb_typeof(observation_json) = 'object'),
  committed_at timestamptz NOT NULL,
  CONSTRAINT team_application_command_receipts_target CHECK (
    (operation = 'ReviseTeamApplicationIntake') = (application_id IS NULL)
  )
);

CREATE INDEX team_application_command_receipts_application
  ON public.team_application_command_receipts (application_id)
  WHERE application_id IS NOT NULL;

-- Attributable history without applicant contact details or free text.
CREATE TABLE public.team_application_audit (
  command_id text PRIMARY KEY REFERENCES public.team_application_command_receipts(command_id),
  action text NOT NULL,
  actor_person_id text NOT NULL CHECK (btrim(actor_person_id) <> ''),
  team_id text NOT NULL REFERENCES public.organization_teams(team_id),
  application_id text NULL,
  accept_application_before boolean NULL,
  deadline_before timestamptz NULL,
  accept_application_after boolean NULL,
  deadline_after timestamptz NULL,
  team_revision_before integer NULL,
  team_revision_after integer NULL,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT team_application_audit_action CHECK (
    (
      action = 'TeamApplicationDeleted'
      AND application_id IS NOT NULL
      AND accept_application_before IS NULL
      AND deadline_before IS NULL
      AND accept_application_after IS NULL
      AND deadline_after IS NULL
      AND team_revision_before IS NULL
      AND team_revision_after IS NULL
    )
    OR (
      action = 'TeamApplicationIntakeRevised'
      AND application_id IS NULL
      AND accept_application_after IS NOT NULL
      AND team_revision_before >= 0
      AND team_revision_after = team_revision_before + 1
    )
  )
);

CREATE INDEX team_application_audit_team_order
  ON public.team_application_audit (team_id, occurred_at, command_id);

-- payload_json holds the private mail envelope. Only claimable or in-flight effects
-- (Pending, Processing, Failed) keep it; Delivered, Quarantined, and Cancelled rows
-- keep only identifiers.
CREATE TABLE public.team_application_outbox (
  effect_id text PRIMARY KEY,
  effect_type text NOT NULL CHECK (
    effect_type IN ('SendTeamApplicationReceipt', 'NotifyTeamOfApplication')
  ),
  team_id text NOT NULL REFERENCES public.organization_teams(team_id),
  application_id text NOT NULL,
  command_id text NOT NULL REFERENCES public.team_application_command_receipts(command_id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  payload_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'Pending' CHECK (
    status IN ('Pending', 'Processing', 'Delivered', 'Failed', 'Quarantined', 'Cancelled')
  ),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_id text NULL,
  claimed_at timestamptz NULL,
  last_failure_tag text NULL,
  committed_at timestamptz NOT NULL,
  UNIQUE (command_id, ordinal),
  CONSTRAINT team_application_outbox_effect_identity CHECK (
    effect_id = command_id || ':' || effect_type
  ),
  CONSTRAINT team_application_outbox_claim CHECK (
    (status = 'Processing' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL)
    OR (status <> 'Processing' AND claim_id IS NULL AND claimed_at IS NULL)
  ),
  CONSTRAINT team_application_outbox_private_payload CHECK (
    (status IN ('Delivered', 'Quarantined', 'Cancelled')) = (payload_json = '{}'::jsonb)
  ),
  CONSTRAINT team_application_outbox_envelope CHECK (
    payload_json = '{}'::jsonb
    OR (
      jsonb_typeof(payload_json) = 'object'
      AND payload_json ->> 'deliveryId' = effect_id
      AND payload_json ?& ARRAY['deliveryId', 'recipient', 'replyTo', 'subject', 'text']
    )
  )
);

CREATE INDEX team_application_outbox_due
  ON public.team_application_outbox (attempts, committed_at, effect_id)
  WHERE status IN ('Pending', 'Failed');

CREATE INDEX team_application_outbox_application
  ON public.team_application_outbox (application_id);

CREATE FUNCTION public.guard_team_application_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.effect_id IS DISTINCT FROM OLD.effect_id
    OR NEW.effect_type IS DISTINCT FROM OLD.effect_type
    OR NEW.team_id IS DISTINCT FROM OLD.team_id
    OR NEW.application_id IS DISTINCT FROM OLD.application_id
    OR NEW.command_id IS DISTINCT FROM OLD.command_id
    OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
    OR NEW.committed_at IS DISTINCT FROM OLD.committed_at THEN
    RAISE EXCEPTION 'Team application outbox identity is immutable';
  END IF;
  IF NEW.payload_json IS DISTINCT FROM OLD.payload_json AND NEW.payload_json <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Team application delivery envelope can only be cleared';
  END IF;
  IF OLD.status IN ('Delivered', 'Quarantined', 'Cancelled')
    AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Team application outbox effect is terminal';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER team_application_outbox_guard
BEFORE UPDATE ON public.team_application_outbox
FOR EACH ROW EXECUTE FUNCTION public.guard_team_application_outbox();
