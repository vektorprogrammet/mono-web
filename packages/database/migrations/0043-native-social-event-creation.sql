CREATE TABLE IF NOT EXISTS public.social_events (
  event_id text PRIMARY KEY,
  department_id text NOT NULL
    REFERENCES public.organization_departments(department_id) ON DELETE RESTRICT,
  semester_id text NOT NULL
    REFERENCES public.admission_period_semesters(semester_id) ON DELETE RESTRICT,
  audience text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  link text NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  created_command_id text NOT NULL UNIQUE,
  CONSTRAINT social_events_id_nonempty CHECK (btrim(event_id) <> ''),
  CONSTRAINT social_events_audience_closed CHECK (
    audience IN ('TeamMembers', 'AssistantsAndTeamMembers')
  ),
  CONSTRAINT social_events_title_valid CHECK (
    title = btrim(title)
    AND char_length(title) BETWEEN 1 AND 255
  ),
  CONSTRAINT social_events_description_valid CHECK (char_length(description) <= 5000),
  CONSTRAINT social_events_link_valid CHECK (
    link IS NULL OR (
      link = btrim(link)
      AND char_length(link) <= 250
    )
  ),
  CONSTRAINT social_events_time_ordered CHECK (end_at >= start_at),
  CONSTRAINT social_events_revision_initial CHECK (revision = 0),
  CONSTRAINT social_events_created_command_nonempty CHECK (btrim(created_command_id) <> '')
);

CREATE TABLE IF NOT EXISTS public.social_event_command_receipts (
  command_id text PRIMARY KEY,
  command_sha256 text NOT NULL,
  command_json jsonb NOT NULL,
  observation_json jsonb NOT NULL,
  event_id text NOT NULL UNIQUE
    REFERENCES public.social_events(event_id) ON DELETE RESTRICT,
  actor_person_id text NOT NULL,
  committed_at timestamptz NOT NULL,
  CONSTRAINT social_event_command_receipts_command_nonempty CHECK (btrim(command_id) <> ''),
  CONSTRAINT social_event_command_receipts_actor_nonempty CHECK (btrim(actor_person_id) <> ''),
  CONSTRAINT social_event_command_receipts_digest CHECK (
    command_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT social_event_command_receipts_json_objects CHECK (
    jsonb_typeof(command_json) = 'object'
    AND jsonb_typeof(observation_json) = 'object'
  ),
  CONSTRAINT social_event_command_receipts_command_link CHECK (
    (command_json ->> '_tag') IS NOT DISTINCT FROM 'CreateSocialEvent'
    AND (command_json ->> 'commandId') IS NOT DISTINCT FROM command_id
    AND (command_json ->> 'eventId') IS NOT DISTINCT FROM event_id
    AND (command_json ->> 'actorPersonId') IS NOT DISTINCT FROM actor_person_id
  ),
  CONSTRAINT social_event_command_receipts_observation_link CHECK (
    (observation_json ->> 'eventId') IS NOT DISTINCT FROM event_id
    AND (observation_json -> 'revision') = '0'::jsonb
  ),
  CONSTRAINT social_event_command_receipts_audit_link UNIQUE (
    command_id,
    event_id,
    actor_person_id,
    committed_at
  )
);

CREATE TABLE IF NOT EXISTS public.social_event_audit (
  command_id text PRIMARY KEY,
  event_id text NOT NULL,
  actor_person_id text NOT NULL,
  action text NOT NULL,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT social_event_audit_action CHECK (action = 'SocialEventCreated'),
  CONSTRAINT social_event_audit_receipt_fk
    FOREIGN KEY (command_id, event_id, actor_person_id, occurred_at)
    REFERENCES public.social_event_command_receipts (
      command_id,
      event_id,
      actor_person_id,
      committed_at
    )
    DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE public.social_events
  DROP CONSTRAINT IF EXISTS social_events_created_command_receipt_fk;
ALTER TABLE public.social_events
  ADD CONSTRAINT social_events_created_command_receipt_fk
  FOREIGN KEY (created_command_id)
  REFERENCES public.social_event_command_receipts(command_id)
  DEFERRABLE INITIALLY DEFERRED;

-- The cyclic, deferred receipt/audit link makes one audit row mandatory for
-- every committed social-event command receipt while preserving one transaction
-- for the event, provenance, and HTTP response receipt.
ALTER TABLE public.social_event_command_receipts
  DROP CONSTRAINT IF EXISTS social_event_command_receipts_audit_required_fk;
ALTER TABLE public.social_event_command_receipts
  ADD CONSTRAINT social_event_command_receipts_audit_required_fk
  FOREIGN KEY (command_id)
  REFERENCES public.social_event_audit(command_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS social_events_scope_start_event_order
  ON public.social_events (department_id, semester_id, start_at ASC, event_id ASC);
CREATE INDEX IF NOT EXISTS social_event_command_receipts_event_order
  ON public.social_event_command_receipts (event_id, committed_at ASC, command_id ASC);
CREATE INDEX IF NOT EXISTS social_event_audit_event_order
  ON public.social_event_audit (event_id, occurred_at ASC, command_id ASC);

CREATE OR REPLACE FUNCTION public.prevent_social_event_provenance_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Social-event command receipts and audit rows are immutable';
END;
$$;

DROP TRIGGER IF EXISTS social_event_command_receipts_immutable
  ON public.social_event_command_receipts;
CREATE TRIGGER social_event_command_receipts_immutable
  BEFORE UPDATE OR DELETE ON public.social_event_command_receipts
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_social_event_provenance_mutation();

DROP TRIGGER IF EXISTS social_event_audit_immutable
  ON public.social_event_audit;
CREATE TRIGGER social_event_audit_immutable
  BEFORE UPDATE OR DELETE ON public.social_event_audit
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_social_event_provenance_mutation();
