ALTER TABLE public.person_cohort_snapshots
  ADD CONSTRAINT person_cohort_snapshots_source_unique
  UNIQUE (snapshot_key, source_repository);

ALTER TABLE public.person_cohort_occurrences
  ADD CONSTRAINT person_cohort_occurrences_disposition_unique
  UNIQUE (snapshot_key, occurrence_id, disposition);

CREATE TABLE public.person_cohort_accepted_mappings (
  snapshot_key text NOT NULL,
  occurrence_id text NOT NULL,
  source_repository text NOT NULL,
  source_user_id text NOT NULL,
  disposition text NOT NULL DEFAULT 'Accepted' CHECK (disposition = 'Accepted'),
  PRIMARY KEY (snapshot_key, occurrence_id),
  UNIQUE (snapshot_key, source_user_id),
  FOREIGN KEY (snapshot_key, source_repository)
    REFERENCES public.person_cohort_snapshots(snapshot_key, source_repository),
  FOREIGN KEY (snapshot_key, occurrence_id, disposition)
    REFERENCES public.person_cohort_occurrences(snapshot_key, occurrence_id, disposition),
  FOREIGN KEY (source_repository, source_user_id)
    REFERENCES public.person_cohort_imports(source_repository, source_user_id)
);

-- Only the original import retains a proven occurrence-to-source identity binding.
-- Older ExactReplay occurrences cannot be identified from their local occurrence IDs.
INSERT INTO public.person_cohort_accepted_mappings
  (snapshot_key, occurrence_id, source_repository, source_user_id)
SELECT i.snapshot_key, i.occurrence_id, i.source_repository, i.source_user_id
FROM public.person_cohort_imports i
JOIN public.person_cohort_occurrences o
  ON o.snapshot_key = i.snapshot_key AND o.occurrence_id = i.occurrence_id
JOIN public.person_cohort_snapshots s
  ON s.snapshot_key = i.snapshot_key AND s.source_repository = i.source_repository
WHERE o.disposition = 'Accepted';

CREATE TRIGGER person_cohort_accepted_mappings_append_only
  BEFORE UPDATE OR DELETE ON public.person_cohort_accepted_mappings
  FOR EACH ROW EXECUTE FUNCTION public.freeze_person_cohort_evidence();
CREATE TRIGGER person_cohort_accepted_mappings_truncate_append_only
  BEFORE TRUNCATE ON public.person_cohort_accepted_mappings
  FOR EACH STATEMENT EXECUTE FUNCTION public.freeze_person_cohort_evidence();
