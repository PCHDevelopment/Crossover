// The service's routes: a small table from a path to a handler.
import { createSessionToken, describeSession, normalizeUserId } from "./auth.js";

export function loginHandler(body) {
  const userId = normalizeUserId(body.userId);
  return { status: 200, token: createSessionToken(userId) };
}

export function whoamiHandler(token) {
  return { status: 200, session: describeSession(token) };
}

export const routes = new Map([
  ["POST /login", loginHandler],
  ["GET /whoami", whoamiHandler],
]);
