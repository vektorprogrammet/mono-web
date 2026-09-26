-- The public application states when and where the applicant can serve: the weekdays that do
-- not suit, a four- or eight-week position, the teaching block of a four-week position, and the
-- teaching language of the school. An application submitted before this migration, and the
-- application of a returning registration, state none of it: all eight columns are NULL together.
ALTER TABLE public.admission_applications
  ADD COLUMN monday_unavailable boolean NULL,
  ADD COLUMN tuesday_unavailable boolean NULL,
  ADD COLUMN wednesday_unavailable boolean NULL,
  ADD COLUMN thursday_unavailable boolean NULL,
  ADD COLUMN friday_unavailable boolean NULL,
  ADD COLUMN position_weeks integer NULL,
  ADD COLUMN preferred_group text NULL,
  ADD COLUMN language text NULL,
  ADD CONSTRAINT admission_applications_position_weeks
    CHECK (position_weeks IN (4, 8)),
  ADD CONSTRAINT admission_applications_preferred_group
    CHECK (preferred_group IN ('all', 'block-1', 'block-2')),
  ADD CONSTRAINT admission_applications_language
    CHECK (language IN ('Norsk', 'Engelsk', 'Norsk og engelsk')),
  ADD CONSTRAINT admission_applications_availability_complete
    CHECK (
      num_nulls(
        monday_unavailable, tuesday_unavailable, wednesday_unavailable, thursday_unavailable,
        friday_unavailable, position_weeks, preferred_group, language
      ) IN (0, 8)
    );
