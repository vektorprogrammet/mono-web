-- Admission outcome mail (spec 0027): versioned, editable message templates and the immutable
-- outbox of announced messages.
--
-- A template is data, never HTML or code. Each revision of one variant (AdmittedWithSchool,
-- AdmittedPlacementPending, Rejected) holds a subject token sequence and a closed, versioned
-- ProseMirror JSON document that the application validates on save with its Schema. Revisions are
-- append-only and consecutive per scope and variant. The scope is the global default
-- (department_id NULL) or one department's override; an override supersedes the global default
-- for its variant only, so no default is copied into a department. The approved Norwegian copy of
-- the three defaults is seeded as global revision 1.
--
-- An announcement stores one rendered envelope {deliveryId, recipient, subject, html, text} in the
-- same transaction as the final outcome. The envelope never changes afterwards: a later template
-- edit, retry or provider answer touches only the delivery columns.

CREATE TABLE public.admission_outcome_template_scopes (
  scope_key text PRIMARY KEY CHECK (scope_key <> '')
);
-- Writers of one scope serialize on its row, as the global scope's row exists from the start.
INSERT INTO public.admission_outcome_template_scopes(scope_key) VALUES ('global');

CREATE TABLE public.admission_outcome_template_revisions (
  revision_id text PRIMARY KEY CHECK (revision_id <> ''),
  department_id text REFERENCES public.organization_departments(department_id),
  kind text NOT NULL CHECK (kind IN ('AdmittedWithSchool','AdmittedPlacementPending','Rejected')),
  revision integer NOT NULL CHECK (revision >= 1),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  subject_json jsonb NOT NULL CHECK (
    jsonb_typeof(subject_json) = 'array' AND jsonb_array_length(subject_json) BETWEEN 1 AND 50
  ),
  body_json jsonb NOT NULL CHECK (
    jsonb_typeof(body_json) = 'object'
    AND body_json->>'type' = 'doc'
    AND body_json->'version' = '1'::jsonb
  ),
  provenance text NOT NULL CHECK (provenance IN ('Seed','Editor')),
  authored_by_person_id text REFERENCES public.person_profiles(person_id),
  authored_at timestamptz NOT NULL,
  CHECK ((provenance = 'Seed') = (authored_by_person_id IS NULL)),
  CHECK (provenance = 'Editor' OR department_id IS NULL),
  CONSTRAINT admission_outcome_template_revisions_authored_at_ms
    CHECK (authored_at = date_trunc('milliseconds', authored_at, 'UTC'))
);
CREATE UNIQUE INDEX admission_outcome_template_global_revision
  ON public.admission_outcome_template_revisions(kind, revision) WHERE department_id IS NULL;
CREATE UNIQUE INDEX admission_outcome_template_department_revision
  ON public.admission_outcome_template_revisions(department_id, kind, revision)
  WHERE department_id IS NOT NULL;

CREATE FUNCTION public.guard_admission_outcome_template_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Admission outcome template revisions are append-only';
  END IF;
  IF NEW.revision <> COALESCE((
      SELECT max(revision) FROM public.admission_outcome_template_revisions
      WHERE kind = NEW.kind AND department_id IS NOT DISTINCT FROM NEW.department_id
    ), 0) + 1 THEN
    RAISE EXCEPTION 'Admission outcome template revision must follow the current revision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER admission_outcome_template_revision_append_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.admission_outcome_template_revisions
  FOR EACH ROW EXECUTE FUNCTION public.guard_admission_outcome_template_revision();

-- The approved default copy. `{x}` in the spec is the atomic placeholder node `x`.
INSERT INTO public.admission_outcome_template_revisions
  (revision_id, department_id, kind, revision, schema_version, subject_json, body_json,
   provenance, authored_by_person_id, authored_at)
VALUES
  ('outcome-template-seed-AdmittedWithSchool', NULL, 'AdmittedWithSchool', 1, 1,
   $json$[
     {"type":"text","text":"Opptaksresultat – "},
     {"type":"placeholder","attrs":{"name":"departmentName"}},
     {"type":"text","text":", "},
     {"type":"placeholder","attrs":{"name":"semesterName"}},
     {"type":"text","text":": Tatt opp"}
   ]$json$::jsonb,
   $json${"version":1,"type":"doc","content":[
     {"type":"paragraph","content":[
       {"type":"text","text":"Hei "},
       {"type":"placeholder","attrs":{"name":"firstName"}},
       {"type":"text","text":","}]},
     {"type":"paragraph","content":[
       {"type":"text","text":"Utfall: Tatt opp. Du er tatt opp som assistent i Vektorprogrammet i "},
       {"type":"placeholder","attrs":{"name":"departmentName"}},
       {"type":"text","text":" for "},
       {"type":"placeholder","attrs":{"name":"semesterName"}},
       {"type":"text","text":"."}]},
     {"type":"paragraph","content":[
       {"type":"text","text":"Skole: "},
       {"type":"placeholder","attrs":{"name":"schoolName"}},
       {"type":"text","text":"."}]},
     {"type":"paragraph","content":[
       {"type":"text","text":"Vennlig hilsen"},
       {"type":"hardBreak"},
       {"type":"text","text":"Vektorprogrammet"}]}
   ]}$json$::jsonb,
   'Seed', NULL, '2026-10-04T00:00:00.000Z'),
  ('outcome-template-seed-AdmittedPlacementPending', NULL, 'AdmittedPlacementPending', 1, 1,
   $json$[
     {"type":"text","text":"Opptaksresultat – "},
     {"type":"placeholder","attrs":{"name":"departmentName"}},
     {"type":"text","text":", "},
     {"type":"placeholder","attrs":{"name":"semesterName"}},
     {"type":"text","text":": Tatt opp"}
   ]$json$::jsonb,
   $json${"version":1,"type":"doc","content":[
     {"type":"paragraph","content":[
       {"type":"text","text":"Hei "},
       {"type":"placeholder","attrs":{"name":"firstName"}},
       {"type":"text","text":","}]},
     {"type":"paragraph","content":[
       {"type":"text","text":"Utfall: Tatt opp. Du er tatt opp som assistent i Vektorprogrammet i "},
       {"type":"placeholder","attrs":{"name":"departmentName"}},
       {"type":"text","text":" for "},
       {"type":"placeholder","attrs":{"name":"semesterName"}},
       {"type":"text","text":"."}]},
     {"type":"paragraph","content":[
       {"type":"text","text":"Skoleplassering kommer."}]},
     {"type":"paragraph","content":[
       {"type":"text","text":"Vennlig hilsen"},
       {"type":"hardBreak"},
       {"type":"text","text":"Vektorprogrammet"}]}
   ]}$json$::jsonb,
   'Seed', NULL, '2026-10-04T00:00:00.000Z'),
  ('outcome-template-seed-Rejected', NULL, 'Rejected', 1, 1,
   $json$[
     {"type":"text","text":"Opptaksresultat – "},
     {"type":"placeholder","attrs":{"name":"departmentName"}},
     {"type":"text","text":", "},
     {"type":"placeholder","attrs":{"name":"semesterName"}},
     {"type":"text","text":": Avslag"}
   ]$json$::jsonb,
   $json${"version":1,"type":"doc","content":[
     {"type":"paragraph","content":[
       {"type":"text","text":"Hei "},
       {"type":"placeholder","attrs":{"name":"firstName"}},
       {"type":"text","text":","}]},
     {"type":"paragraph","content":[
       {"type":"text","text":"Utfall: Avslag. Du fikk dessverre ikke plass i Vektorprogrammet i "},
       {"type":"placeholder","attrs":{"name":"departmentName"}},
       {"type":"text","text":" for "},
       {"type":"placeholder","attrs":{"name":"semesterName"}},
       {"type":"text","text":"."}]},
     {"type":"paragraph","content":[
       {"type":"text","text":"Vennlig hilsen"},
       {"type":"hardBreak"},
       {"type":"text","text":"Vektorprogrammet"}]}
   ]}$json$::jsonb,
   'Seed', NULL, '2026-10-04T00:00:00.000Z');

-- One immutable envelope per announced application. The claim columns follow the shared outbox
-- lifecycle (outbox-lifecycle.ts); `last_attempt_at` orders the retry backoff of a Failed row.
CREATE TABLE public.admission_outcome_outbox (
  effect_id text PRIMARY KEY CHECK (effect_id <> ''),
  application_id text NOT NULL UNIQUE REFERENCES public.admission_applications(application_id),
  kind text NOT NULL CHECK (kind IN ('AdmittedWithSchool','AdmittedPlacementPending','Rejected')),
  template_revision_id text NOT NULL
    REFERENCES public.admission_outcome_template_revisions(revision_id),
  status text NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending','Processing','Delivered','Failed','Quarantined')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_id text,
  claimed_at timestamptz,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  provider_reference text CHECK (provider_reference IS NULL OR provider_reference <> ''),
  last_failure_tag text,
  committed_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now(), 'UTC'),
  payload_json jsonb NOT NULL CHECK (
    jsonb_typeof(payload_json) = 'object'
    AND payload_json ?& ARRAY['deliveryId','recipient','subject','html','text']
    AND (payload_json - 'deliveryId' - 'recipient' - 'subject' - 'html' - 'text') = '{}'::jsonb
    AND jsonb_typeof(payload_json->'deliveryId') = 'string'
    AND jsonb_typeof(payload_json->'recipient') = 'string'
    AND jsonb_typeof(payload_json->'subject') = 'string'
    AND jsonb_typeof(payload_json->'html') = 'string'
    AND jsonb_typeof(payload_json->'text') = 'string'
    AND payload_json->>'deliveryId' = effect_id
  ),
  CHECK ((status = 'Processing' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL)
    OR (status <> 'Processing' AND claim_id IS NULL AND claimed_at IS NULL)),
  CHECK ((status = 'Delivered') = (delivered_at IS NOT NULL)),
  CHECK (status = 'Delivered' OR provider_reference IS NULL),
  CONSTRAINT admission_outcome_outbox_claimed_at_ms
    CHECK (claimed_at = date_trunc('milliseconds', claimed_at, 'UTC')),
  CONSTRAINT admission_outcome_outbox_last_attempt_at_ms
    CHECK (last_attempt_at = date_trunc('milliseconds', last_attempt_at, 'UTC')),
  CONSTRAINT admission_outcome_outbox_delivered_at_ms
    CHECK (delivered_at = date_trunc('milliseconds', delivered_at, 'UTC')),
  CONSTRAINT admission_outcome_outbox_committed_at_ms
    CHECK (committed_at = date_trunc('milliseconds', committed_at, 'UTC'))
);
CREATE INDEX admission_outcome_outbox_claimable
  ON public.admission_outcome_outbox(status, attempts, effect_id)
  WHERE status IN ('Pending','Failed');

CREATE FUNCTION public.guard_admission_outcome_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Admission outcome mail is never deleted';
  END IF;
  IF NEW.effect_id IS DISTINCT FROM OLD.effect_id
    OR NEW.application_id IS DISTINCT FROM OLD.application_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.template_revision_id IS DISTINCT FROM OLD.template_revision_id
    OR NEW.payload_json IS DISTINCT FROM OLD.payload_json
    OR NEW.committed_at IS DISTINCT FROM OLD.committed_at THEN
    RAISE EXCEPTION 'Admission outcome mail envelope is immutable';
  END IF;
  IF OLD.status IN ('Delivered','Quarantined') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Admission outcome mail delivery status is final';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER admission_outcome_outbox_guard
  BEFORE UPDATE OR DELETE ON public.admission_outcome_outbox
  FOR EACH ROW EXECUTE FUNCTION public.guard_admission_outcome_outbox();
