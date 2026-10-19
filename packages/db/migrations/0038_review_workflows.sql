-- Review requests, rounds, and line-anchored threads (§8.5).
ALTER TABLE tasks
  ADD COLUMN required_approvals smallint NOT NULL DEFAULT 1
    CONSTRAINT tasks_required_approvals_range CHECK (required_approvals BETWEEN 1 AND 5),
  ADD COLUMN review_round integer NOT NULL DEFAULT 0
    CONSTRAINT tasks_review_round_nonneg CHECK (review_round >= 0);
UPDATE tasks SET review_round = 1 WHERE status = 'REVIEW';

ALTER TABLE task_reviews DROP CONSTRAINT task_reviews_verdict_check;
ALTER TABLE task_reviews
  ADD CONSTRAINT task_reviews_verdict_check CHECK (verdict IN ('APPROVE', 'REQUEST_CHANGES', 'COMMENT')),
  ADD COLUMN round integer NOT NULL DEFAULT 0 CONSTRAINT task_reviews_round_nonneg CHECK (round >= 0),
  ADD COLUMN overrides text[] NOT NULL DEFAULT '{}'
    CONSTRAINT task_reviews_overrides_known CHECK (overrides <@ ARRAY['health', 'approvals']::text[]);
CREATE INDEX task_reviews_task_round ON task_reviews (task_id, round);

CREATE TABLE task_review_requests (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms (id),
  task_id text NOT NULL,
  reviewer_id text NOT NULL,
  requested_by text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REMOVED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT task_review_requests_once UNIQUE (task_id, reviewer_id),
  FOREIGN KEY (task_id, room_id) REFERENCES tasks (id, room_id),
  FOREIGN KEY (reviewer_id, room_id) REFERENCES participants (id, room_id),
  FOREIGN KEY (requested_by, room_id) REFERENCES participants (id, room_id)
);
CREATE INDEX task_review_requests_reviewer ON task_review_requests (room_id, reviewer_id) WHERE status = 'ACTIVE';

CREATE TABLE review_threads (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms (id),
  task_id text NOT NULL,
  path text NOT NULL CHECK (path <> '' AND length(path) <= 4096),
  anchor_revision bigint NOT NULL CHECK (anchor_revision >= 0),
  start_line integer NOT NULL CHECK (start_line >= 1),
  end_line integer NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  comment_count integer NOT NULL DEFAULT 1 CHECK (comment_count BETWEEN 1 AND 100),
  created_by text NOT NULL,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT review_threads_range CHECK (end_line >= start_line AND end_line - start_line < 500),
  CONSTRAINT review_threads_resolution
    CHECK ((status = 'RESOLVED') = (resolved_by IS NOT NULL AND resolved_at IS NOT NULL)),
  CONSTRAINT review_threads_id_room_unique UNIQUE (id, room_id),
  FOREIGN KEY (task_id, room_id) REFERENCES tasks (id, room_id),
  FOREIGN KEY (created_by, room_id) REFERENCES participants (id, room_id),
  FOREIGN KEY (resolved_by, room_id) REFERENCES participants (id, room_id)
);
CREATE INDEX review_threads_task ON review_threads (task_id, created_at, id);

CREATE TABLE review_comments (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms (id),
  thread_id text NOT NULL,
  author_id text NOT NULL,
  body text NOT NULL CHECK (body <> '' AND length(body) <= 10000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (thread_id, room_id) REFERENCES review_threads (id, room_id),
  FOREIGN KEY (author_id, room_id) REFERENCES participants (id, room_id)
);
CREATE INDEX review_comments_thread ON review_comments (thread_id, created_at, id);
