CREATE TABLE public.current_assignment_reviews (
  snapshot_key text PRIMARY KEY REFERENCES public.current_assignment_snapshots(snapshot_key),
  source_kind text NOT NULL CHECK (source_kind = 'ReviewedLegacy'),
  reference_digest text NOT NULL CHECK (reference_digest ~ '^[a-f0-9]{64}$'),
  person_snapshot_key text NOT NULL REFERENCES public.person_cohort_snapshots(snapshot_key),
  source_semester_id text NOT NULL,
  as_of date NOT NULL,
  review jsonb NOT NULL CHECK (jsonb_typeof(review) = 'object'),
  CHECK (review->>'sourceSemesterId' = source_semester_id),
  CHECK (review->>'asOf' = to_char(as_of, 'YYYY-MM-DD'))
);

CREATE TRIGGER current_assignment_reviews_append_only
  BEFORE UPDATE OR DELETE ON public.current_assignment_reviews
  FOR EACH ROW EXECUTE FUNCTION public.prevent_current_assignment_reconciliation_mutation();
CREATE TRIGGER current_assignment_reviews_truncate_append_only
  BEFORE TRUNCATE ON public.current_assignment_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_current_assignment_reconciliation_mutation();
