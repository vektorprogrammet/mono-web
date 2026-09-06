CREATE TABLE public.organization_volunteer_affiliations (
  person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  department_id text NOT NULL REFERENCES public.organization_departments(department_id),
  status text NOT NULL CHECK(status IN ('Pending','Active','Inactive')),
  revision integer NOT NULL CHECK(revision > 0),
  PRIMARY KEY(person_id, department_id)
);
CREATE TABLE public.organization_volunteer_affiliation_audit (
  person_id text NOT NULL,
  department_id text NOT NULL,
  revision integer NOT NULL,
  action text NOT NULL CHECK(action IN ('Request','Withdraw','Establish','Reject','Revoke')),
  actor_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY(person_id,department_id,revision),
  FOREIGN KEY(person_id,department_id) REFERENCES public.organization_volunteer_affiliations(person_id,department_id)
);
CREATE TABLE public.assistant_placements (
  placement_id text PRIMARY KEY CHECK(placement_id ~ '^placement-[a-f0-9]{64}$'),
  person_id text NOT NULL,
  department_id text NOT NULL,
  semester_id text NOT NULL REFERENCES public.admission_period_semesters(semester_id),
  school_id bigint NOT NULL REFERENCES public.schools_directory_schools(school_id),
  day text NOT NULL CHECK(day IN ('Monday','Tuesday','Wednesday','Thursday','Friday')),
  workdays integer NOT NULL CHECK(workdays BETWEEN 1 AND 8),
  block text NOT NULL CHECK(block IN ('1','2','Both')),
  active boolean NOT NULL,
  revision integer NOT NULL CHECK(revision > 0),
  FOREIGN KEY(person_id, department_id) REFERENCES public.organization_volunteer_affiliations(person_id,department_id),
  FOREIGN KEY(school_id, department_id) REFERENCES public.schools_directory_departments(school_id,department_id)
);
CREATE UNIQUE INDEX assistant_placements_active_unique ON public.assistant_placements(person_id,school_id,semester_id,block) WHERE active;
CREATE TABLE public.assistant_placement_audit (
  placement_id text NOT NULL REFERENCES public.assistant_placements(placement_id),
  revision integer NOT NULL,
  actor_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  occurred_at timestamptz NOT NULL,
  action text NOT NULL CHECK(action IN ('Create','Edit','Remove')),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  PRIMARY KEY(placement_id,revision)
);
