-- Team application notifications deliver through Effect's PersistedQueue SQL store.
--
-- team_application_outbox keeps each committed notification's identity, private envelope,
-- delivery policy, and outcome: Pending, Failed (a temporary failure waits for its retry),
-- Delivered, Quarantined, or Cancelled. Its queue item in effect_queue names only the
-- effect and owns the lease, the attempt count, and the retry visibility. The submit
-- transaction writes both rows.
--
-- This chain owns the store schema. The store's own Migrator would create it on the first
-- connection's search_path (auth, public on the shared pool) at process start. The
-- pre-recorded store migrations 1 and 2 leave that Migrator nothing to run. The lease and
-- visibility columns are timestamptz: the store compares them with NOW() in SQL only, and
-- wall-clock timestamp columns would shift at a DST change.
CREATE TABLE public.effect_queue (
  sequence bigserial PRIMARY KEY,
  id varchar(255) NOT NULL,
  queue_name varchar(255) NOT NULL,
  element text NOT NULL,
  state varchar(10) NOT NULL CONSTRAINT effect_queue_state
    CHECK (state IN ('pending', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CONSTRAINT effect_queue_attempts CHECK (attempts >= 0),
  last_failure text NULL,
  visible_at timestamptz NOT NULL,
  acquired_at timestamptz NULL,
  acquired_by uuid NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX idx_effect_queue_id ON public.effect_queue (id, queue_name);

CREATE INDEX idx_effect_queue_update ON public.effect_queue (sequence, acquired_by);

CREATE INDEX idx_effect_queue_take ON public.effect_queue (queue_name, visible_at)
  WHERE state = 'pending';

CREATE TABLE public.effect_queue_migrations (
  migration_id integer PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now(), 'UTC')
    CONSTRAINT effect_queue_migrations_created_at_ms
    CHECK (created_at = date_trunc('milliseconds', created_at, 'UTC')),
  name text NOT NULL
);

INSERT INTO public.effect_queue_migrations (migration_id, name)
VALUES (1, 'create_table'), (2, 'upgrade_schema');

-- Every effect becomes a queue item under its effect id, with its attempt count, in
-- commit order. A terminal effect's item is completed, so the queue keeps its identity for
-- offer de-duplication, as it does for an item that completes. A Processing row keeps its
-- lease from its claim time under the nil worker id, which no store holds: a worker takes
-- it again once the lease expires, as stale-claim recovery did. Pending and Failed rows
-- keep their status and failure tag and are visible at once.
INSERT INTO public.effect_queue (
  id, queue_name, element, state, attempts, visible_at, acquired_at, acquired_by, created_at,
  updated_at
)
SELECT
  effect_id,
  'team-application-notification',
  json_build_object('effectId', effect_id)::text,
  CASE WHEN status IN ('Delivered', 'Quarantined', 'Cancelled') THEN 'completed' ELSE 'pending' END,
  attempts,
  now(),
  CASE WHEN status = 'Processing' THEN claimed_at END,
  CASE WHEN status = 'Processing' THEN '00000000-0000-0000-0000-000000000000'::uuid END,
  committed_at,
  now()
FROM public.team_application_outbox
ORDER BY committed_at, command_id, ordinal;

-- The lease now carries Processing, so the outbox row of an in-flight effect is Pending.
UPDATE public.team_application_outbox
SET status = 'Pending', claim_id = NULL, claimed_at = NULL
WHERE status = 'Processing';

-- No worker can write the claim columns from here on: a claim sets Processing and a claim
-- id, which these constraints reject, and a settle names a claim id that no row holds.
-- An insert must name its status, so a process that still runs the claim outbox fails its
-- submission instead of committing a notification without a queue item. Migration 79
-- drops the claim columns.
ALTER TABLE public.team_application_outbox
  ALTER COLUMN status DROP DEFAULT,
  DROP CONSTRAINT team_application_outbox_status_check,
  ADD CONSTRAINT team_application_outbox_status
    CHECK (status IN ('Pending', 'Failed', 'Delivered', 'Quarantined', 'Cancelled')),
  DROP CONSTRAINT team_application_outbox_claim,
  ADD CONSTRAINT team_application_outbox_unclaimed CHECK (claim_id IS NULL AND claimed_at IS NULL);

-- One read of each notification's delivery state. An effect without an outcome is
-- Processing while its queue item is leased and otherwise keeps its outbox status. A
-- missing item is Unqueued, and an item that the queue finished without an outcome is
-- Unsettled; neither arises from a committed submission.
CREATE VIEW public.team_application_delivery_state AS
SELECT
  outbox.effect_id,
  outbox.effect_type,
  outbox.team_id,
  outbox.application_id,
  outbox.command_id,
  outbox.ordinal,
  outbox.committed_at,
  CASE
    WHEN outbox.status IN ('Delivered', 'Quarantined', 'Cancelled') THEN outbox.status
    WHEN queue.id IS NULL THEN 'Unqueued'
    WHEN queue.state <> 'pending' THEN 'Unsettled'
    WHEN queue.acquired_by IS NOT NULL THEN 'Processing'
    ELSE outbox.status
  END AS status,
  COALESCE(queue.attempts, 0) AS attempts,
  outbox.last_failure_tag,
  CASE
    WHEN outbox.status IN ('Pending', 'Failed') AND queue.state = 'pending'
      THEN queue.visible_at
  END AS next_attempt_at
FROM public.team_application_outbox AS outbox
LEFT JOIN public.effect_queue AS queue
  ON queue.queue_name = 'team-application-notification'
  AND queue.id = outbox.effect_id;
