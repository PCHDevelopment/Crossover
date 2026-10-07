-- Decisions and positions (ARCHITECTURE §7.1-7.2, T404). A decision is a choice made with
-- authority and a written rationale; positions are participants' structured arguments for one
-- of its options. The columns for deciding, withdrawing and vetoing (T405, T406) are here so
-- those tasks need no migration of their own.
CREATE TABLE decisions (
  id                text PRIMARY KEY,
  room_id           text NOT NULL REFERENCES rooms (id),
  title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  context           text NOT NULL DEFAULT '' CHECK (char_length(context) <= 20000),
  -- `[{ "id": "opt_1", "summary": "…", "detail": "…" }, …]`, at least two, ids unique.
  options           jsonb NOT NULL CHECK (
                      jsonb_typeof(options) = 'array' AND jsonb_array_length(options) >= 2),
  status            text NOT NULL DEFAULT 'PROPOSED' CHECK (
                      status IN ('PROPOSED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN',
                                 'SUPERSEDED', 'VETOED')),
  outcome_option_id text,
  rationale         text,
  proposed_by       text NOT NULL,
  decided_by        text,
  vetoed_by         text,
  veto_rationale    text,
  decide_by         timestamptz,
  -- What it concerns: `[{ "kind": "task", "id": "task_…" }, …]`.
  links             jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(links) = 'array'),
  supersedes        text,
  version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at        timestamptz,
  vetoed_at         timestamptz,

  CONSTRAINT decisions_id_room_unique UNIQUE (id, room_id),
  FOREIGN KEY (proposed_by, room_id) REFERENCES participants (id, room_id),
  FOREIGN KEY (decided_by, room_id) REFERENCES participants (id, room_id),
  FOREIGN KEY (vetoed_by, room_id) REFERENCES participants (id, room_id),
  FOREIGN KEY (supersedes, room_id) REFERENCES decisions (id, room_id),
  -- An outcome only exists once someone has decided.
  CONSTRAINT decisions_outcome_needs_decision CHECK (
    outcome_option_id IS NULL OR status IN ('ACCEPTED', 'SUPERSEDED', 'VETOED'))
);

CREATE INDEX decisions_room_status ON decisions (room_id, status, created_at, id);

-- One position per participant per decision; adding another replaces it.
CREATE TABLE decision_positions (
  decision_id    text NOT NULL,
  room_id        text NOT NULL,
  participant_id text NOT NULL,
  option_id      text NOT NULL,
  argument       text NOT NULL CHECK (char_length(argument) BETWEEN 1 AND 10000),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),

  PRIMARY KEY (decision_id, participant_id),
  FOREIGN KEY (decision_id, room_id) REFERENCES decisions (id, room_id),
  FOREIGN KEY (participant_id, room_id) REFERENCES participants (id, room_id)
);
