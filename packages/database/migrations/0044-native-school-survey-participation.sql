CREATE TABLE IF NOT EXISTS public.native_survey_definitions (
  survey_id text PRIMARY KEY,
  department_id text NOT NULL
    REFERENCES public.organization_departments(department_id) ON DELETE RESTRICT,
  semester_id text NOT NULL
    REFERENCES public.admission_period_semesters(semester_id) ON DELETE RESTRICT,
  semester_label text NOT NULL,
  title text NOT NULL,
  completion_text text NOT NULL,
  target_audience text NOT NULL,
  CONSTRAINT native_survey_definitions_id_valid CHECK (
    btrim(survey_id) <> ''
    AND survey_id = btrim(survey_id)
    AND survey_id NOT IN ('.', '..')
    AND octet_length(survey_id) <= 128
  ),
  CONSTRAINT native_survey_definitions_semester_label_valid CHECK (
    btrim(semester_label) <> ''
    AND semester_label = btrim(semester_label)
    AND octet_length(semester_label) <= 100
  ),
  CONSTRAINT native_survey_definitions_title_valid CHECK (
    btrim(title) <> '' AND title = btrim(title) AND octet_length(title) <= 255
  ),
  CONSTRAINT native_survey_definitions_completion_text_valid CHECK (
    completion_text = btrim(completion_text) AND octet_length(completion_text) <= 4096
  ),
  CONSTRAINT native_survey_definitions_audience_closed CHECK (
    target_audience IN ('School', 'Team', 'Assistant')
  ),
  CONSTRAINT native_survey_definitions_survey_department_unique UNIQUE (survey_id, department_id)
);

CREATE TABLE IF NOT EXISTS public.school_survey_questions (
  question_id text PRIMARY KEY,
  survey_id text NOT NULL
    REFERENCES public.native_survey_definitions(survey_id) ON DELETE RESTRICT,
  question_type text NOT NULL,
  label text NOT NULL,
  help_text text NULL,
  required boolean NOT NULL,
  position integer NOT NULL,
  CONSTRAINT school_survey_questions_id_valid CHECK (
    btrim(question_id) <> '' AND question_id = btrim(question_id) AND octet_length(question_id) <= 128
  ),
  CONSTRAINT school_survey_questions_type_closed CHECK (
    question_type IN ('Text', 'List', 'Radio', 'Check')
  ),
  CONSTRAINT school_survey_questions_label_valid CHECK (
    btrim(label) <> '' AND label = btrim(label) AND octet_length(label) <= 1000
  ),
  CONSTRAINT school_survey_questions_help_text_valid CHECK (
    help_text IS NULL
    OR (btrim(help_text) <> '' AND help_text = btrim(help_text) AND octet_length(help_text) <= 1000)
  ),
  CONSTRAINT school_survey_questions_position_valid CHECK (position BETWEEN 0 AND 99),
  CONSTRAINT school_survey_questions_survey_position_unique UNIQUE (survey_id, position),
  CONSTRAINT school_survey_questions_question_survey_unique UNIQUE (question_id, survey_id)
);

CREATE TABLE IF NOT EXISTS public.school_survey_question_alternatives (
  alternative_id text PRIMARY KEY,
  question_id text NOT NULL
    REFERENCES public.school_survey_questions(question_id) ON DELETE RESTRICT,
  value text NOT NULL,
  position integer NOT NULL,
  CONSTRAINT school_survey_question_alternatives_id_valid CHECK (
    btrim(alternative_id) <> ''
    AND alternative_id = btrim(alternative_id)
    AND octet_length(alternative_id) <= 128
  ),
  CONSTRAINT school_survey_question_alternatives_value_valid CHECK (
    btrim(value) <> '' AND value = btrim(value) AND octet_length(value) <= 500
  ),
  CONSTRAINT school_survey_question_alternatives_position_valid CHECK (position BETWEEN 0 AND 99),
  CONSTRAINT school_survey_question_alternatives_question_position_unique
    UNIQUE (question_id, position),
  CONSTRAINT school_survey_question_alternatives_question_value_unique
    UNIQUE (question_id, value)
);

CREATE TABLE IF NOT EXISTS public.school_survey_responses (
  response_id text PRIMARY KEY,
  survey_id text NOT NULL,
  department_id text NOT NULL,
  school_id bigint NOT NULL,
  submitted_at timestamptz NOT NULL,
  CONSTRAINT school_survey_responses_id_valid CHECK (
    btrim(response_id) <> '' AND response_id = btrim(response_id) AND octet_length(response_id) <= 128
  ),
  CONSTRAINT school_survey_responses_response_survey_unique UNIQUE (response_id, survey_id),
  CONSTRAINT school_survey_responses_survey_department_fk
    FOREIGN KEY (survey_id, department_id)
    REFERENCES public.native_survey_definitions (survey_id, department_id)
    ON DELETE RESTRICT,
  CONSTRAINT school_survey_responses_school_department_fk
    FOREIGN KEY (school_id, department_id)
    REFERENCES public.schools_directory_departments (school_id, department_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.school_survey_answers (
  response_id text NOT NULL,
  survey_id text NOT NULL,
  question_id text NOT NULL,
  answer_value text NULL,
  answer_values jsonb NULL,
  CONSTRAINT school_survey_answers_response_question_unique PRIMARY KEY (response_id, question_id),
  CONSTRAINT school_survey_answers_response_survey_fk
    FOREIGN KEY (response_id, survey_id)
    REFERENCES public.school_survey_responses (response_id, survey_id)
    ON DELETE CASCADE,
  CONSTRAINT school_survey_answers_question_survey_fk
    FOREIGN KEY (question_id, survey_id)
    REFERENCES public.school_survey_questions (question_id, survey_id)
    ON DELETE RESTRICT,
  CONSTRAINT school_survey_answers_text_value_valid CHECK (
    answer_value IS NULL
    OR (btrim(answer_value) <> '' AND answer_value = btrim(answer_value) AND octet_length(answer_value) <= 4096)
  ),
  CONSTRAINT school_survey_answers_one_representation CHECK (
    (answer_value IS NOT NULL AND answer_values IS NULL)
    OR (answer_value IS NULL AND answer_values IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION public.validate_school_survey_answer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  type_value text;
  value_count integer;
  distinct_value_count integer;
  expected_values jsonb;
BEGIN
  SELECT question_type
  INTO type_value
  FROM public.school_survey_questions
  WHERE question_id = NEW.question_id
    AND survey_id = NEW.survey_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Survey answer must reference a question in its response survey';
  END IF;

  IF type_value IN ('Text', 'List', 'Radio') THEN
    IF NEW.answer_value IS NULL OR NEW.answer_values IS NOT NULL THEN
      RAISE EXCEPTION 'Text, List, and Radio answers require exactly one value';
    END IF;
    IF type_value IN ('List', 'Radio') AND NOT EXISTS (
      SELECT 1
      FROM public.school_survey_question_alternatives
      WHERE question_id = NEW.question_id
        AND value = NEW.answer_value
    ) THEN
      RAISE EXCEPTION 'List and Radio answers must use a configured alternative';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.answer_value IS NOT NULL
    OR NEW.answer_values IS NULL
    OR jsonb_typeof(NEW.answer_values) <> 'array' THEN
    RAISE EXCEPTION 'Check answers require one ordered value list';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.answer_values) AS element(value)
    WHERE jsonb_typeof(element.value) <> 'string'
      OR btrim(element.value #>> '{}') = ''
      OR element.value #>> '{}' <> btrim(element.value #>> '{}')
      OR octet_length(element.value #>> '{}') > 500
  ) THEN
    RAISE EXCEPTION 'Check answer values must be bounded, trimmed nonempty strings';
  END IF;

  SELECT count(*)::integer, count(DISTINCT element.value #>> '{}')::integer
  INTO value_count, distinct_value_count
  FROM jsonb_array_elements(NEW.answer_values) AS element(value);
  IF value_count = 0 OR value_count > 100 OR value_count <> distinct_value_count THEN
    RAISE EXCEPTION 'Check answer values must be nonempty, unique, and bounded';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.answer_values) AS element(value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.school_survey_question_alternatives
      WHERE question_id = NEW.question_id
        AND value = element.value #>> '{}'
    )
  ) THEN
    RAISE EXCEPTION 'Check answer values must use configured alternatives';
  END IF;

  SELECT jsonb_agg(alternative.value ORDER BY alternative.position ASC)
  INTO expected_values
  FROM public.school_survey_question_alternatives AS alternative
  WHERE alternative.question_id = NEW.question_id
    AND alternative.value IN (
      SELECT element.value #>> '{}'
      FROM jsonb_array_elements(NEW.answer_values) AS element(value)
    );

  IF expected_values IS DISTINCT FROM NEW.answer_values THEN
    RAISE EXCEPTION 'Check answer values must follow configured alternative order';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS school_survey_answers_validate
  ON public.school_survey_answers;
CREATE TRIGGER school_survey_answers_validate
BEFORE INSERT OR UPDATE OF response_id, survey_id, question_id, answer_value, answer_values
ON public.school_survey_answers
FOR EACH ROW
EXECUTE FUNCTION public.validate_school_survey_answer();

CREATE INDEX IF NOT EXISTS school_survey_questions_survey_order
  ON public.school_survey_questions (survey_id, position ASC, question_id ASC);
CREATE INDEX IF NOT EXISTS school_survey_question_alternatives_question_order
  ON public.school_survey_question_alternatives (question_id, position ASC, alternative_id ASC);
CREATE INDEX IF NOT EXISTS school_survey_responses_survey_submitted_order
  ON public.school_survey_responses (survey_id, submitted_at ASC, response_id ASC);
CREATE INDEX IF NOT EXISTS school_survey_answers_response_order
  ON public.school_survey_answers (response_id, question_id ASC);
