ALTER TABLE public.schools_directory_departments
  DROP CONSTRAINT schools_directory_departments_school_id_fkey,
  ADD CONSTRAINT schools_directory_departments_school_id_fkey
    FOREIGN KEY (school_id) REFERENCES public.schools_directory_schools(school_id) ON DELETE RESTRICT;

CREATE TABLE public.schools_capacity_plans (
  capacity_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY CHECK (capacity_id > 0 AND capacity_id <= 9007199254740991),
  school_id bigint NOT NULL,
  department_id text NOT NULL,
  semester_id text NOT NULL REFERENCES public.admission_period_semesters(semester_id) ON DELETE RESTRICT,
  monday integer NOT NULL CHECK (monday >= 0),
  tuesday integer NOT NULL CHECK (tuesday >= 0),
  wednesday integer NOT NULL CHECK (wednesday >= 0),
  thursday integer NOT NULL CHECK (thursday >= 0),
  friday integer NOT NULL CHECK (friday >= 0),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  UNIQUE(school_id,department_id,semester_id),
  FOREIGN KEY(school_id,department_id) REFERENCES public.schools_directory_departments(school_id,department_id) ON DELETE RESTRICT
);

CREATE TABLE public.schools_command_receipts (
  actor_person_id text NOT NULL REFERENCES public.person_profiles(person_id) ON DELETE RESTRICT,
  command_id text NOT NULL CHECK (command_id ~ '^[A-Za-z0-9_-]{22,128}$'),
  command_digest text NOT NULL CHECK (command_digest ~ '^[a-f0-9]{64}$'),
  result_json jsonb NOT NULL,
  PRIMARY KEY(actor_person_id,command_id)
);
CREATE TABLE public.schools_administration_audit (
  actor_person_id text NOT NULL,
  command_id text NOT NULL,
  school_id bigint NOT NULL REFERENCES public.schools_directory_schools(school_id) ON DELETE RESTRICT,
  capacity_id bigint REFERENCES public.schools_capacity_plans(capacity_id) ON DELETE RESTRICT,
  department_id text REFERENCES public.organization_departments(department_id) ON DELETE RESTRICT,
  scope_department_ids text[] NOT NULL,
  action text NOT NULL CHECK (action IN ('CreateSchool','ReviseSchool','ReplaceSchoolDepartments','CreateCapacity','ReviseCapacity')),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  revision integer NOT NULL CHECK (revision >= 0),
  before_json jsonb,
  after_json jsonb NOT NULL,
  PRIMARY KEY(actor_person_id,command_id),
  FOREIGN KEY(actor_person_id,command_id) REFERENCES public.schools_command_receipts(actor_person_id,command_id) ON DELETE RESTRICT
);
CREATE FUNCTION public.freeze_school_administration_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'School administration evidence is immutable'; END $$;
CREATE TRIGGER schools_command_receipts_immutable BEFORE UPDATE OR DELETE ON public.schools_command_receipts
  FOR EACH ROW EXECUTE FUNCTION public.freeze_school_administration_evidence();
CREATE TRIGGER schools_administration_audit_immutable BEFORE UPDATE OR DELETE ON public.schools_administration_audit
  FOR EACH ROW EXECUTE FUNCTION public.freeze_school_administration_evidence();
