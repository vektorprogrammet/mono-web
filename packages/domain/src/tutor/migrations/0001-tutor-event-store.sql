CREATE TABLE stream_heads (
  person_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  semester_year INTEGER NOT NULL,
  semester_term TEXT NOT NULL CHECK (semester_term IN ('Vår', 'Høst')),
  current_version INTEGER NOT NULL CHECK (current_version >= 0),
  last_command_id TEXT,
  PRIMARY KEY (person_id, department_id, semester_year, semester_term),
  CHECK (
    (current_version = 0 AND last_command_id IS NULL)
    OR (current_version > 0 AND last_command_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE tutor_events (
  person_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  semester_year INTEGER NOT NULL,
  semester_term TEXT NOT NULL CHECK (semester_term IN ('Vår', 'Høst')),
  event_id TEXT NOT NULL,
  stream_version INTEGER NOT NULL CHECK (stream_version > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  event_type TEXT NOT NULL,
  envelope_bytes BLOB NOT NULL CHECK (typeof(envelope_bytes) = 'blob'),
  occurred_at TEXT NOT NULL,
  causation_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  PRIMARY KEY (person_id, department_id, semester_year, semester_term, event_id),
  UNIQUE (person_id, department_id, semester_year, semester_term, stream_version),
  UNIQUE (
    person_id,
    department_id,
    semester_year,
    semester_term,
    event_id,
    stream_version,
    causation_id
  ),
  FOREIGN KEY (person_id, department_id, semester_year, semester_term)
    REFERENCES stream_heads (person_id, department_id, semester_year, semester_term)
) STRICT;

CREATE TABLE command_receipts (
  person_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  semester_year INTEGER NOT NULL,
  semester_term TEXT NOT NULL CHECK (semester_term IN ('Vår', 'Høst')),
  command_id TEXT NOT NULL,
  command_bytes BLOB NOT NULL CHECK (typeof(command_bytes) = 'blob'),
  command_sha256 TEXT NOT NULL,
  result_bytes BLOB NOT NULL CHECK (typeof(result_bytes) = 'blob'),
  descriptor_bytes BLOB NOT NULL CHECK (typeof(descriptor_bytes) = 'blob'),
  event_id TEXT NOT NULL,
  event_stream_version INTEGER NOT NULL CHECK (event_stream_version > 0),
  PRIMARY KEY (command_id),
  FOREIGN KEY (
    person_id,
    department_id,
    semester_year,
    semester_term,
    event_id,
    event_stream_version,
    command_id
  ) REFERENCES tutor_events (
    person_id,
    department_id,
    semester_year,
    semester_term,
    event_id,
    stream_version,
    causation_id
  )
) STRICT;

CREATE TRIGGER tutor_events_immutable_update
BEFORE UPDATE ON tutor_events
BEGIN
  SELECT RAISE(ABORT, 'tutor_events are immutable');
END;

CREATE TRIGGER tutor_events_immutable_delete
BEFORE DELETE ON tutor_events
BEGIN
  SELECT RAISE(ABORT, 'tutor_events are immutable');
END;

CREATE TRIGGER command_receipts_immutable_update
BEFORE UPDATE ON command_receipts
BEGIN
  SELECT RAISE(ABORT, 'command_receipts are immutable');
END;

CREATE TRIGGER command_receipts_immutable_delete
BEFORE DELETE ON command_receipts
BEGIN
  SELECT RAISE(ABORT, 'command_receipts are immutable');
END;
