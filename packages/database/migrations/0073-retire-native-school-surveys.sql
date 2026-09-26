-- Surveys stay in Google Forms, so the system owns no surveys or survey responses.
-- Drop the native school-survey tables of 0044 and 0045 and their guard functions.
-- One statement drops the tables together because native_survey_definitions and
-- school_survey_audit reference each other. The triggers go with their tables.
DROP TABLE IF EXISTS
  public.school_survey_answers,
  public.school_survey_responses,
  public.school_survey_question_alternatives,
  public.school_survey_questions,
  public.school_survey_audit,
  public.native_survey_definitions;

DROP FUNCTION IF EXISTS
  public.validate_school_survey_answer(),
  public.guard_native_school_survey_definition(),
  public.guard_school_survey_audit();
