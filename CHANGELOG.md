# Changelog

## Unreleased

### Changed

- **Agents' default event subscription is now `relevant`** (T704, §17.1). An agent that subscribes
  without a `profile` receives what concerns it (its tasks and reviews, mentions, its ChangeSets and
  conflicts, lead decisions and changes, room status, new unowned tasks, health RED where it is a
  suspect) instead of every event. Humans still get `all`. To keep the old behaviour, subscribe with
  `profile: "all"`. A filtered stream skips sequence numbers by design. An event written before its
  type carried the fields the filter needs is delivered (the filter fails open).
