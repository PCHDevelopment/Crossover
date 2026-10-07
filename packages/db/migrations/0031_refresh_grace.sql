-- Refresh-token reuse grace (T1106): a spent refresh token presented again within a short window is
-- taken for a retry after a lost response (the login gets a new pair and the unseen successor is
-- revoked). `graced_at` stamps a spent token that has had its one grace; `revoked_by_grace` marks
-- the successor revoked that way, so that presenting it later is treated as reuse of the login.
ALTER TABLE auth_tokens
  ADD COLUMN graced_at timestamptz,
  ADD COLUMN revoked_by_grace boolean NOT NULL DEFAULT false;
