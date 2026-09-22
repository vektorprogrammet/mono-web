-- 0113: managed School-survey lifecycle, result policy, and immutable provenance.
-- Existing imported definitions deliberately remain valid Open rows with no native
-- creator provenance. Only newly created School surveys require the cyclic audit link.
ALTER TABLE public.native_survey_definitions
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'Open';
ALTER TABLE public.native_survey_definitions
  ADD COLUMN IF NOT EXISTS results_visibility text NOT NULL DEFAULT 'DepartmentManagers';
ALTER TABLE public.native_survey_definitions
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
ALTER TABLE public.native_survey_definitions
  ADD COLUMN IF NOT EXISTS created_by_person_id text NULL
    REFERENCES public.person_profiles(person_id) ON DELETE RESTRICT;
ALTER TABLE public.native_survey_definitions
  ADD COLUMN IF NOT EXISTS created_at timestamptz NULL;
ALTER TABLE public.native_survey_definitions
  ADD COLUMN IF NOT EXISTS creation_command_id text NULL;
ALTER TABLE public.native_survey_definitions
  ADD COLUMN IF NOT EXISTS closed_by_person_id text NULL
    REFERENCES public.person_profiles(person_id) ON DELETE RESTRICT;
ALTER TABLE public.native_survey_definitions
  ADD COLUMN IF NOT EXISTS closed_at timestamptz NULL;
ALTER TABLE public.native_survey_definitions
  ADD COLUMN IF NOT EXISTS close_command_id text NULL;

ALTER TABLE public.native_survey_definitions
  DROP CONSTRAINT IF EXISTS native_survey_definitions_state_closed;
ALTER TABLE public.native_survey_definitions
  ADD CONSTRAINT native_survey_definitions_state_closed
  CHECK (state IN ('Open', 'Closed'));
ALTER TABLE public.native_survey_definitions
  DROP CONSTRAINT IF EXISTS native_survey_definitions_results_visibility_closed;
ALTER TABLE public.native_survey_definitions
  ADD CONSTRAINT native_survey_definitions_results_visibility_closed
  CHECK (results_visibility IN ('DepartmentManagers', 'GlobalAdministrators'));
ALTER TABLE public.native_survey_definitions
  DROP CONSTRAINT IF EXISTS native_survey_definitions_revision_nonnegative;
ALTER TABLE public.native_survey_definitions
  ADD CONSTRAINT native_survey_definitions_revision_nonnegative
  CHECK (revision >= 0);
ALTER TABLE public.native_survey_definitions
  DROP CONSTRAINT IF EXISTS native_survey_definitions_creation_provenance_shape;
ALTER TABLE public.native_survey_definitions
  ADD CONSTRAINT native_survey_definitions_creation_provenance_shape
  CHECK (
    (created_by_person_id IS NULL AND created_at IS NULL AND creation_command_id IS NULL)
    OR (
      created_by_person_id IS NOT NULL
      AND created_at IS NOT NULL
      AND creation_command_id IS NOT NULL
      AND btrim(creation_command_id) <> ''
      AND octet_length(creation_command_id) <= 128
    )
  );
ALTER TABLE public.native_survey_definitions
  DROP CONSTRAINT IF EXISTS native_survey_definitions_close_provenance_shape;
ALTER TABLE public.native_survey_definitions
  ADD CONSTRAINT native_survey_definitions_close_provenance_shape
  CHECK (
    (state = 'Open' AND closed_by_person_id IS NULL AND closed_at IS NULL AND close_command_id IS NULL)
    OR (
      state = 'Closed'
      AND revision > 0
      AND closed_by_person_id IS NOT NULL
      AND closed_at IS NOT NULL
      AND close_command_id IS NOT NULL
      AND btrim(close_command_id) <> ''
      AND octet_length(close_command_id) <= 128
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS native_survey_definitions_creation_command_unique
  ON public.native_survey_definitions (creation_command_id)
  WHERE creation_command_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS native_survey_definitions_close_command_unique
  ON public.native_survey_definitions (close_command_id)
  WHERE close_command_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS native_survey_definitions_admin_scope_order
  ON public.native_survey_definitions (
    department_id,
    semester_id,
    created_at ASC NULLS FIRST,
    survey_id ASC
  )
  WHERE target_audience = 'School';

CREATE TABLE IF NOT EXISTS public.school_survey_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  survey_id text NOT NULL
    REFERENCES public.native_survey_definitions(survey_id) ON DELETE RESTRICT,
  department_id text NOT NULL
    REFERENCES public.organization_departments(department_id) ON DELETE RESTRICT,
  actor_person_id text NOT NULL
    REFERENCES public.person_profiles(person_id) ON DELETE RESTRICT,
  command_id text NOT NULL UNIQUE,
  action text NOT NULL CHECK (action IN ('Created', 'Closed')),
  occurred_at timestamptz NOT NULL,
  survey_revision integer NOT NULL CHECK (survey_revision >= 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT school_survey_audit_command_valid CHECK (
    btrim(command_id) <> '' AND command_id = btrim(command_id) AND octet_length(command_id) <= 128
  ),
  CONSTRAINT school_survey_audit_action_revision CHECK (
    (action = 'Created' AND survey_revision = 0)
    OR (action = 'Closed' AND survey_revision > 0)
  )
);
CREATE INDEX IF NOT EXISTS school_survey_audit_survey_order
  ON public.school_survey_audit (survey_id, audit_id ASC);

ALTER TABLE public.native_survey_definitions
  DROP CONSTRAINT IF EXISTS native_survey_definitions_creation_audit_fk;
ALTER TABLE public.native_survey_definitions
  ADD CONSTRAINT native_survey_definitions_creation_audit_fk
  FOREIGN KEY (creation_command_id)
  REFERENCES public.school_survey_audit(command_id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.native_survey_definitions
  DROP CONSTRAINT IF EXISTS native_survey_definitions_close_audit_fk;
ALTER TABLE public.native_survey_definitions
  ADD CONSTRAINT native_survey_definitions_close_audit_fk
  FOREIGN KEY (close_command_id)
  REFERENCES public.school_survey_audit(command_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION public.guard_native_school_survey_definition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.target_audience <> 'School' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'School survey definitions are immutable';
  END IF;
  IF NEW.survey_id IS DISTINCT FROM OLD.survey_id
    OR NEW.department_id IS DISTINCT FROM OLD.department_id
    OR NEW.semester_id IS DISTINCT FROM OLD.semester_id
    OR NEW.semester_label IS DISTINCT FROM OLD.semester_label
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.completion_text IS DISTINCT FROM OLD.completion_text
    OR NEW.target_audience IS DISTINCT FROM OLD.target_audience
    OR NEW.results_visibility IS DISTINCT FROM OLD.results_visibility
    OR NEW.created_by_person_id IS DISTINCT FROM OLD.created_by_person_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.creation_command_id IS DISTINCT FROM OLD.creation_command_id THEN
    RAISE EXCEPTION 'School survey definition is immutable after creation';
  END IF;
  IF OLD.state = 'Open'
    AND NEW.state = 'Closed'
    AND NEW.revision = OLD.revision + 1
    AND OLD.closed_by_person_id IS NULL
    AND OLD.closed_at IS NULL
    AND OLD.close_command_id IS NULL
    AND NEW.closed_by_person_id IS NOT NULL
    AND NEW.closed_at IS NOT NULL
    AND NEW.close_command_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'School survey lifecycle transition is invalid';
END;
$$;

DROP TRIGGER IF EXISTS native_survey_definitions_school_lifecycle_guard
  ON public.native_survey_definitions;
CREATE TRIGGER native_survey_definitions_school_lifecycle_guard
BEFORE UPDATE OR DELETE ON public.native_survey_definitions
FOR EACH ROW
EXECUTE FUNCTION public.guard_native_school_survey_definition();

CREATE OR REPLACE FUNCTION public.guard_school_survey_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  definition_department_id text;
  definition_state text;
  definition_revision integer;
  definition_created_by_person_id text;
  definition_created_at timestamptz;
  definition_creation_command_id text;
  definition_closed_by_person_id text;
  definition_closed_at timestamptz;
  definition_close_command_id text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'School survey audit rows are immutable';
  END IF;
  SELECT
    department_id,
    state,
    revision,
    created_by_person_id,
    created_at,
    creation_command_id,
    closed_by_person_id,
    closed_at,
    close_command_id
  INTO
    definition_department_id,
    definition_state,
    definition_revision,
    definition_created_by_person_id,
    definition_created_at,
    definition_creation_command_id,
    definition_closed_by_person_id,
    definition_closed_at,
    definition_close_command_id
  FROM public.native_survey_definitions
  WHERE survey_id = NEW.survey_id
    AND target_audience = 'School';

  IF NOT FOUND OR NEW.department_id IS DISTINCT FROM definition_department_id THEN
    RAISE EXCEPTION 'School survey audit must retain its School-survey owner';
  END IF;
  IF NEW.action = 'Created' AND (
    definition_state IS DISTINCT FROM 'Open'
    OR definition_revision IS DISTINCT FROM 0
    OR NEW.command_id IS DISTINCT FROM definition_creation_command_id
    OR NEW.actor_person_id IS DISTINCT FROM definition_created_by_person_id
    OR NEW.occurred_at IS DISTINCT FROM definition_created_at
    OR NEW.survey_revision IS DISTINCT FROM definition_revision
  ) THEN
    RAISE EXCEPTION 'School survey creation audit must match its definition';
  END IF;
  IF NEW.action = 'Closed' AND (
    definition_state IS DISTINCT FROM 'Closed'
    OR NEW.command_id IS DISTINCT FROM definition_close_command_id
    OR NEW.actor_person_id IS DISTINCT FROM definition_closed_by_person_id
    OR NEW.occurred_at IS DISTINCT FROM definition_closed_at
    OR NEW.survey_revision IS DISTINCT FROM definition_revision
  ) THEN
    RAISE EXCEPTION 'School survey closure audit must match its definition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS school_survey_audit_guard
  ON public.school_survey_audit;
CREATE TRIGGER school_survey_audit_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.school_survey_audit
FOR EACH ROW
EXECUTE FUNCTION public.guard_school_survey_audit();
