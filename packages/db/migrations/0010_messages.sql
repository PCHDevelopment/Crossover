-- Room messages (ARCHITECTURE §17.5, T401). A message is plain text from a participant to the
-- room; `mentions` are explicit participant ids (the server never parses @names). The text as
-- first sent stays in the event ledger (`message.sent`); `body` here is the current text.
CREATE TABLE messages (
  id         text PRIMARY KEY,
  room_id    text NOT NULL REFERENCES rooms (id),
  author_id  text NOT NULL,
  body       text NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 32768),
  mentions   text[] NOT NULL DEFAULT '{}',
  -- What the message is about: `[{ "kind": "task", "id": "task_…" }, …]`.
  refs       jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(refs) = 'array'),
  reply_to   text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  edited_at  timestamptz,

  FOREIGN KEY (author_id, room_id) REFERENCES participants (id, room_id),
  CONSTRAINT messages_id_room_unique UNIQUE (id, room_id),
  FOREIGN KEY (reply_to, room_id) REFERENCES messages (id, room_id),
  CONSTRAINT messages_edit_after_creation CHECK (edited_at IS NULL OR edited_at >= created_at)
);

-- Paging and "latest N" both walk (created_at, id) within a room.
CREATE INDEX messages_room_created ON messages (room_id, created_at, id);
