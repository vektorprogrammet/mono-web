CREATE TABLE IF NOT EXISTS public.native_http_idempotency_receipts (
  identity_sha256 text PRIMARY KEY,
  request_sha256 text NOT NULL,
  operation_id text NOT NULL,
  state text NOT NULL,
  status integer NULL,
  media_type text NULL,
  body_bytes bytea NULL,
  headers_json jsonb NULL,
  committed_at timestamptz NOT NULL,
  full_expires_at timestamptz NOT NULL,
  tombstoned_at timestamptz NULL,
  CONSTRAINT native_http_idempotency_receipts_identity_sha256 CHECK (
    identity_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT native_http_idempotency_receipts_request_sha256 CHECK (
    request_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT native_http_idempotency_receipts_operation CHECK (
    operation_id = btrim(operation_id) AND operation_id <> ''
  ),
  CONSTRAINT native_http_idempotency_receipts_state CHECK (
    state IN ('Complete', 'Tombstone')
  ),
  CONSTRAINT native_http_idempotency_receipts_status CHECK (
    status IS NULL OR status BETWEEN 200 AND 599
  ),
  CONSTRAINT native_http_idempotency_receipts_expiry CHECK (
    full_expires_at = committed_at + interval '24 hours'
  ),
  CONSTRAINT native_http_idempotency_receipts_headers CHECK (
    headers_json IS NULL OR (
      jsonb_typeof(headers_json) = 'object'
      AND headers_json - 'content-type' - 'etag' - 'location' - 'retry-after' = '{}'::jsonb
      AND (headers_json -> 'content-type' IS NULL OR jsonb_typeof(headers_json -> 'content-type') = 'string')
      AND (headers_json -> 'etag' IS NULL OR jsonb_typeof(headers_json -> 'etag') = 'string')
      AND (headers_json -> 'location' IS NULL OR jsonb_typeof(headers_json -> 'location') = 'string')
      AND (headers_json -> 'retry-after' IS NULL OR jsonb_typeof(headers_json -> 'retry-after') = 'string')
    )
  ),
  CONSTRAINT native_http_idempotency_receipts_complete CHECK (
    (
      state = 'Complete'
      AND status IS NOT NULL
      AND tombstoned_at IS NULL
      AND headers_json IS NOT NULL
      AND headers_json ->> 'content-type' IS NOT DISTINCT FROM media_type
      AND (
        (body_bytes IS NULL AND media_type IS NULL)
        OR (body_bytes IS NOT NULL AND media_type IS NOT NULL)
      )
    ) OR (
      state = 'Tombstone'
      AND status IS NULL
      AND media_type IS NULL
      AND body_bytes IS NULL
      AND headers_json IS NULL
      AND tombstoned_at IS NOT NULL
      AND tombstoned_at >= full_expires_at
    )
  )
);

CREATE INDEX IF NOT EXISTS native_http_idempotency_receipts_identity_request
  ON public.native_http_idempotency_receipts (identity_sha256, request_sha256);

CREATE INDEX IF NOT EXISTS native_http_idempotency_receipts_redaction
  ON public.native_http_idempotency_receipts (full_expires_at)
  WHERE state = 'Complete';

CREATE TABLE IF NOT EXISTS public.profile_http_versions (
  person_id text PRIMARY KEY REFERENCES public.person_profiles(person_id) ON DELETE CASCADE,
  representation_revision integer NOT NULL DEFAULT 0,
  CONSTRAINT profile_http_versions_revision_nonnegative CHECK (representation_revision >= 0)
);

INSERT INTO public.profile_http_versions (person_id, representation_revision)
SELECT person_id, 0
FROM public.person_profiles
ON CONFLICT (person_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.ensure_profile_http_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.profile_http_versions (person_id, representation_revision)
  VALUES (NEW.person_id, 0)
  ON CONFLICT (person_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS person_profiles_http_version_insert ON public.person_profiles;
CREATE TRIGGER person_profiles_http_version_insert
AFTER INSERT ON public.person_profiles
FOR EACH ROW
EXECUTE FUNCTION public.ensure_profile_http_version();

CREATE OR REPLACE FUNCTION public.increment_profile_http_authority_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selected_person_id text;
BEGIN
  selected_person_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.person_id ELSE NEW.person_id END;
  INSERT INTO public.profile_http_versions AS http_version (person_id, representation_revision)
  VALUES (selected_person_id, 1)
  ON CONFLICT (person_id) DO UPDATE
    SET representation_revision = http_version.representation_revision + 1;

  IF TG_OP = 'UPDATE' AND OLD.person_id <> NEW.person_id THEN
    INSERT INTO public.profile_http_versions AS http_version (person_id, representation_revision)
    VALUES (OLD.person_id, 1)
    ON CONFLICT (person_id) DO UPDATE
      SET representation_revision = http_version.representation_revision + 1;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS organization_global_administrator_grants_profile_http_version
  ON public.organization_global_administrator_grants;
CREATE TRIGGER organization_global_administrator_grants_profile_http_version
AFTER INSERT OR UPDATE OR DELETE ON public.organization_global_administrator_grants
FOR EACH ROW
EXECUTE FUNCTION public.increment_profile_http_authority_version();

DROP TRIGGER IF EXISTS organization_memberships_profile_http_version
  ON public.organization_memberships;
CREATE TRIGGER organization_memberships_profile_http_version
AFTER INSERT OR UPDATE OR DELETE ON public.organization_memberships
FOR EACH ROW
EXECUTE FUNCTION public.increment_profile_http_authority_version();

ALTER TABLE public.admission_period_departments
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
ALTER TABLE public.admission_period_departments
  DROP CONSTRAINT IF EXISTS admission_period_departments_revision_nonnegative;
ALTER TABLE public.admission_period_departments
  ADD CONSTRAINT admission_period_departments_revision_nonnegative CHECK (revision >= 0);

ALTER TABLE public.admission_period_semesters
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
ALTER TABLE public.admission_period_semesters
  DROP CONSTRAINT IF EXISTS admission_period_semesters_revision_nonnegative;
ALTER TABLE public.admission_period_semesters
  ADD CONSTRAINT admission_period_semesters_revision_nonnegative CHECK (revision >= 0);

ALTER TABLE public.admission_period_fields_of_study
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
ALTER TABLE public.admission_period_fields_of_study
  DROP CONSTRAINT IF EXISTS admission_period_fields_of_study_revision_nonnegative;
ALTER TABLE public.admission_period_fields_of_study
  ADD CONSTRAINT admission_period_fields_of_study_revision_nonnegative CHECK (revision >= 0);

CREATE OR REPLACE FUNCTION public.increment_native_http_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS admission_period_departments_http_revision
  ON public.admission_period_departments;
CREATE TRIGGER admission_period_departments_http_revision
BEFORE UPDATE ON public.admission_period_departments
FOR EACH ROW
WHEN (OLD IS DISTINCT FROM NEW)
EXECUTE FUNCTION public.increment_native_http_revision();

DROP TRIGGER IF EXISTS admission_period_semesters_http_revision
  ON public.admission_period_semesters;
CREATE TRIGGER admission_period_semesters_http_revision
BEFORE UPDATE ON public.admission_period_semesters
FOR EACH ROW
WHEN (OLD IS DISTINCT FROM NEW)
EXECUTE FUNCTION public.increment_native_http_revision();

DROP TRIGGER IF EXISTS admission_period_fields_of_study_http_revision
  ON public.admission_period_fields_of_study;
CREATE TRIGGER admission_period_fields_of_study_http_revision
BEFORE UPDATE ON public.admission_period_fields_of_study
FOR EACH ROW
WHEN (OLD IS DISTINCT FROM NEW)
EXECUTE FUNCTION public.increment_native_http_revision();

CREATE OR REPLACE FUNCTION public.increment_content_article_department_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selected_article_id bigint;
BEGIN
  IF current_setting('vektor.content_revision_managed', true) = 'on' THEN
    RETURN NULL;
  END IF;
  selected_article_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.article_id ELSE NEW.article_id END;
  UPDATE public.content_articles
  SET revision = revision + 1
  WHERE article_id = selected_article_id;
  IF TG_OP = 'UPDATE' AND OLD.article_id <> NEW.article_id THEN
    UPDATE public.content_articles SET revision = revision + 1 WHERE article_id = OLD.article_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS content_article_departments_http_revision
  ON public.content_article_departments;
CREATE TRIGGER content_article_departments_http_revision
AFTER INSERT OR UPDATE OR DELETE ON public.content_article_departments
FOR EACH ROW
EXECUTE FUNCTION public.increment_content_article_department_revision();

CREATE TABLE IF NOT EXISTS public.recruitment_invitation_response_command_receipts (
  command_id text PRIMARY KEY,
  command_sha256 text NOT NULL,
  invitation_id text NOT NULL REFERENCES public.recruitment_invitations(invitation_id) ON DELETE RESTRICT,
  resulting_response_revision integer NOT NULL,
  committed_at timestamptz NOT NULL,
  CONSTRAINT recruitment_invitation_response_command_receipts_command CHECK (
    command_id ~ '^httpv2_[A-Za-z0-9_-]{43}$'
  ),
  CONSTRAINT recruitment_invitation_response_command_receipts_digest CHECK (
    command_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT recruitment_invitation_response_command_receipts_revision CHECK (
    resulting_response_revision >= 0
  )
);

CREATE INDEX IF NOT EXISTS recruitment_invitation_response_command_receipts_invitation
  ON public.recruitment_invitation_response_command_receipts (invitation_id, committed_at);
