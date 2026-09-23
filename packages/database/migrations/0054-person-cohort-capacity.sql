ALTER TABLE public.person_cohort_snapshots
  DROP CONSTRAINT person_cohort_snapshots_occurrence_count_check;

ALTER TABLE public.person_cohort_snapshots
  ADD CONSTRAINT person_cohort_snapshots_occurrence_count_check
  CHECK (occurrence_count BETWEEN 1 AND 10000);
