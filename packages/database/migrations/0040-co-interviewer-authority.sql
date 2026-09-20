-- 0106: nullable co-interviewer designation for completed assessment correction authority.
ALTER TABLE public.recruitment_interviews
  ADD COLUMN co_interviewer_person_id text NULL
    REFERENCES public.person_profiles(person_id);

ALTER TABLE public.recruitment_interviews
  ADD CONSTRAINT recruitment_interviews_co_interviewer_distinct
    CHECK (
      co_interviewer_person_id IS NULL
      OR co_interviewer_person_id <> interviewer_person_id
    );
