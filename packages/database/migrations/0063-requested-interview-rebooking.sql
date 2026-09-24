ALTER TABLE public.recruitment_interview_schedules
  DROP CONSTRAINT recruitment_interview_schedules_pkey;
-- The existing (interview_id, schedule_revision) unique key retains all foreign keys.
ALTER TABLE public.recruitment_schedule_command_receipts
  DROP CONSTRAINT recruitment_schedule_receipts_interview_unique,
  ADD CONSTRAINT recruitment_schedule_receipts_schedule_unique UNIQUE (interview_id, schedule_revision);

CREATE FUNCTION public.freeze_recruitment_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Interview schedule history is immutable';
END $$;
CREATE TRIGGER recruitment_interview_schedules_immutable
  BEFORE UPDATE OR DELETE ON public.recruitment_interview_schedules
  FOR EACH ROW EXECUTE FUNCTION public.freeze_recruitment_schedule();
