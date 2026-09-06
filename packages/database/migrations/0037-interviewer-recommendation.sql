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

-- PostgreSQL snapshot custody: a lock alone does not invalidate older serializable snapshots.
-- https://www.postgresql.org/docs/current/applevel-consistency.html#NON-SERIALIZABLE-CONSISTENCY
-- Version the applicant only when its immutable identity association is established.
CREATE FUNCTION public.version_applicant_identity_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE public.admission_applicants SET applicant_id=applicant_id WHERE applicant_id=NEW.applicant_id;
 RETURN NEW;
END $$;
CREATE TRIGGER applicant_account_link_custody BEFORE INSERT ON public.applicant_account_links
FOR EACH ROW EXECUTE FUNCTION public.version_applicant_identity_link();
