-- Who wrote what an inbox item says (ARCHITECTURE §16.5, §34.5). Summaries quote other
-- participants (a mention's text, a task's title, an agent's declared model); the reader must be
-- able to tell that from platform text. `system` is the platform's own wording. Existing rows
-- predate the label and read as platform text. New rows must say, so the column has no default.
ALTER TABLE inbox_items ADD COLUMN author_id text NOT NULL DEFAULT 'system';
ALTER TABLE inbox_items ALTER COLUMN author_id DROP DEFAULT;
