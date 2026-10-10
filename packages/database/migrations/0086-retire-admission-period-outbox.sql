-- The admission period outbox had a producer and no consumer. Migration 0002 created it, and every
-- period create or revise inserted one PublishAdmissionPeriodChanged row in the command transaction.
-- No worker claimed those rows and nothing read them, so they only accumulated as Pending. The
-- period, its command receipt, and its audit row carry the same facts and stay.
-- The primary key, the unique constraint, the check constraints (the claim check of 0002 and the
-- millisecond check of 0072), and both indexes go with the table. No other table, view, function,
-- or trigger references it, so the statement runs without CASCADE and refuses if one ever does.
DROP TABLE IF EXISTS public.admission_period_outbox;
