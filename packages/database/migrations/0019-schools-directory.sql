CREATE TABLE IF NOT EXISTS schools_directory_schools (
  school_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  contact_person text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  language text NOT NULL,
  active boolean NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT schools_directory_schools_id_safe CHECK (
    school_id > 0 AND school_id <= 9007199254740991
  ),
  CONSTRAINT schools_directory_schools_name_valid CHECK (
    btrim(name) <> '' AND char_length(name) <= 255
  ),
  CONSTRAINT schools_directory_schools_contact_person_valid CHECK (
    btrim(contact_person) <> '' AND char_length(contact_person) <= 255
  ),
  CONSTRAINT schools_directory_schools_email_valid CHECK (
    btrim(email) <> '' AND char_length(email) <= 255 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$'
  ),
  CONSTRAINT schools_directory_schools_phone_valid CHECK (
    btrim(phone) <> '' AND char_length(phone) <= 255
  ),
  CONSTRAINT schools_directory_schools_language_valid CHECK (
    language IN ('Norwegian', 'International')
  ),
  CONSTRAINT schools_directory_schools_revision_nonnegative CHECK (revision >= 0)
);

CREATE TABLE IF NOT EXISTS schools_directory_departments (
  school_id bigint NOT NULL REFERENCES schools_directory_schools(school_id) ON DELETE CASCADE,
  department_id text NOT NULL REFERENCES organization_departments(department_id) ON DELETE RESTRICT,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT schools_directory_departments_revision_nonnegative CHECK (revision >= 0),
  PRIMARY KEY (school_id, department_id)
);

CREATE INDEX IF NOT EXISTS schools_directory_departments_department_school_order
  ON schools_directory_departments (department_id, school_id);

CREATE INDEX IF NOT EXISTS schools_directory_schools_stable_directory_order
  ON schools_directory_schools (name COLLATE "C", school_id);
