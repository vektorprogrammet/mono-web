UPDATE admission_application_outbox
SET payload_json = '{}'::jsonb
WHERE status = 'Delivered'
  AND payload_json <> '{}'::jsonb;
