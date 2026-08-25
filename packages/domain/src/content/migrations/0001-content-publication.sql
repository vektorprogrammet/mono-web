CREATE TABLE IF NOT EXISTS content_articles (
  article_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL,
  slug text NOT NULL,
  body_html text NOT NULL,
  sticky boolean NOT NULL DEFAULT FALSE,
  created_by_person_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  current_version_number integer NULL,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT content_articles_id_safe CHECK (
    article_id > 0 AND article_id <= 9007199254740991
  ),
  CONSTRAINT content_articles_title_valid CHECK (
    btrim(title) <> '' AND char_length(title) <= 255
  ),
  CONSTRAINT content_articles_slug_valid CHECK (
    slug ~ '^[a-z0-9-]+$' AND char_length(slug) <= 255
  ),
  CONSTRAINT content_articles_body_valid CHECK (char_length(body_html) <= 100000),
  CONSTRAINT content_articles_revision_nonnegative CHECK (revision >= 0),
  CONSTRAINT content_articles_version_positive CHECK (
    current_version_number IS NULL OR current_version_number >= 1
  )
);

CREATE TABLE IF NOT EXISTS content_article_versions (
  article_id bigint NOT NULL REFERENCES content_articles(article_id) ON DELETE RESTRICT,
  version_number integer NOT NULL,
  title text NOT NULL,
  slug text NOT NULL,
  body_html text NOT NULL,
  sticky boolean NOT NULL,
  published_at timestamptz NOT NULL,
  published_by_person_id text NOT NULL,
  CONSTRAINT content_article_versions_pk PRIMARY KEY (article_id, version_number),
  CONSTRAINT content_article_versions_version_positive CHECK (version_number >= 1),
  CONSTRAINT content_article_versions_title_valid CHECK (
    btrim(title) <> '' AND char_length(title) <= 255
  ),
  CONSTRAINT content_article_versions_slug_valid CHECK (
    slug ~ '^[a-z0-9-]+$' AND char_length(slug) <= 255
  ),
  CONSTRAINT content_article_versions_body_valid CHECK (char_length(body_html) <= 100000)
);

CREATE UNIQUE INDEX IF NOT EXISTS content_article_versions_slug_number_unique
  ON content_article_versions (slug, version_number);

-- Immutable snapshots: no UPDATE or DELETE ever reaches committed versions.
DROP RULE IF EXISTS content_article_versions_no_update ON content_article_versions;
CREATE RULE content_article_versions_no_update AS ON UPDATE
  TO content_article_versions DO INSTEAD NOTHING;
DROP RULE IF EXISTS content_article_versions_no_delete ON content_article_versions;
CREATE RULE content_article_versions_no_delete AS ON DELETE
  TO content_article_versions DO INSTEAD NOTHING;

CREATE TABLE IF NOT EXISTS content_article_departments (
  article_id bigint NOT NULL REFERENCES content_articles(article_id) ON DELETE CASCADE,
  department_id text NOT NULL REFERENCES organization_departments(department_id) ON DELETE RESTRICT,
  PRIMARY KEY (article_id, department_id)
);

CREATE INDEX IF NOT EXISTS content_article_departments_department_order
  ON content_article_departments (department_id, article_id);

CREATE TABLE IF NOT EXISTS content_publication_command_receipts (
  command_id text PRIMARY KEY,
  article_id bigint NOT NULL REFERENCES content_articles(article_id) ON DELETE RESTRICT,
  kind text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  result_json jsonb NOT NULL,
  committed_at timestamptz NOT NULL,
  CONSTRAINT content_publication_command_kind_valid CHECK (
    kind IN ('CreateDraft', 'ReviseDraft', 'Publish', 'Unpublish')
  )
);

CREATE TABLE IF NOT EXISTS content_publication_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  command_id text NOT NULL REFERENCES content_publication_command_receipts(command_id),
  article_id bigint NOT NULL REFERENCES content_articles(article_id) ON DELETE RESTRICT,
  actor_person_id text NOT NULL,
  action text NOT NULL,
  version_number integer NULL,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT content_publication_audit_id_safe CHECK (
    audit_id > 0 AND audit_id <= 9007199254740991
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS content_publication_audit_command_unique
  ON content_publication_audit (command_id);

CREATE UNIQUE INDEX IF NOT EXISTS content_articles_slug_unique
  ON content_articles (slug);

-- Listing order index over published snapshots; the read-time inner join on
-- the articles' current_version_number restricts it to current rows.
CREATE UNIQUE INDEX IF NOT EXISTS content_article_versions_current_listing_order
  ON content_article_versions (sticky DESC, published_at DESC, article_id DESC);

CREATE INDEX IF NOT EXISTS content_articles_current_version_fk_order
  ON content_articles (current_version_number);
