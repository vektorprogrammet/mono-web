-- 0101: historical immutable conducts retain NULL; every new insert must record an explicit recommendation.
ALTER TABLE public.recruitment_interview_conducts ADD COLUMN recommendation text
  CHECK (recommendation IN ('Ja','Kanskje','Nei'));
CREATE FUNCTION public.require_interviewer_recommendation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.recommendation IS NULL THEN RAISE EXCEPTION 'New interview conduct requires an explicit recommendation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recruitment_interview_recommendation_required BEFORE INSERT ON public.recruitment_interview_conducts
FOR EACH ROW EXECUTE FUNCTION public.require_interviewer_recommendation();
