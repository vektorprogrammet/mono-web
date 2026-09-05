-- Contact content never persists. One bounded quota record per visitor, pruned on requests.
CREATE TABLE public.contact_rate_windows (
  visitor_ip inet PRIMARY KEY CHECK (masklen(visitor_ip) = CASE family(visitor_ip) WHEN 4 THEN 32 ELSE 128 END),
  attempts smallint NOT NULL CHECK (attempts BETWEEN 1 AND 5),
  expires_at timestamptz NOT NULL
);
CREATE INDEX contact_rate_windows_expiry ON public.contact_rate_windows (expires_at);
