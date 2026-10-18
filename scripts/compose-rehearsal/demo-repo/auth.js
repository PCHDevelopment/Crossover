// Session handling for the Project Alpha demo service.
// Plain JavaScript with no dependencies, so it needs no install step.

const TOKEN_PREFIX = "token:";
const DEFAULT_SESSION_SECONDS = 3600;
const MAX_SESSION_SECONDS = 86400;
const MIN_PASSWORD_LENGTH = 12;

/** Lower-case a user id and trim it: the one place ids are normalised. */
export function normalizeUserId(userId) {
  if (typeof userId !== "string") throw new TypeError("userId must be a string");
  const normalized = userId.trim().toLowerCase();
  if (normalized.length === 0) throw new RangeError("userId must not be empty");
  return normalized;
}

/** A session token for a user. Tokens are opaque to callers. */
export function createSessionToken(userId) {
  return `${TOKEN_PREFIX}${normalizeUserId(userId)}`;
}

/** The user a session token belongs to, or null when it is not one of ours. */
export function userFromToken(token) {
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return null;
  const userId = token.slice(TOKEN_PREFIX.length);
  return userId.length > 0 ? userId : null;
}

/** How long a session lasts, in seconds, for a requested lifetime. */
export function sessionDurationSeconds(requested) {
  if (requested === undefined) return DEFAULT_SESSION_SECONDS;
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new RangeError("the session lifetime must be a positive whole number of seconds");
  }
  return Math.min(requested, MAX_SESSION_SECONDS);
}

/** Whether a session that started at `startedAt` (ms) is still valid at `now` (ms). */
export function isSessionValid(startedAt, now, lifetimeSeconds) {
  const lifetime = sessionDurationSeconds(lifetimeSeconds);
  const elapsedSeconds = (now - startedAt) / 1000;
  // A clock that went backwards must not extend a session.
  if (elapsedSeconds < 0) return false;
  if (elapsedSeconds >= lifetime) return false;
  return true;
}

/** Why a password is not acceptable, or null when it is. */
export function passwordProblem(password) {
  if (typeof password !== "string") return "the password must be a string";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `the password needs at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
    return "the password needs both lower-case and upper-case letters";
  }
  if (!/[0-9]/.test(password)) return "the password needs a digit";
  return null;
}

/** A short description of a session for the audit log. Never includes the token itself. */
export function describeSession(token) {
  const userId = userFromToken(token);
  return userId === null ? "no session" : `session for ${userId}`;
}
