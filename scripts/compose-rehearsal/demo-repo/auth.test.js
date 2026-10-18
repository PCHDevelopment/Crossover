import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionToken,
  isSessionValid,
  passwordProblem,
  sessionDurationSeconds,
  userFromToken,
} from "./auth.js";
import { loginHandler } from "./routes.js";

test("a token names the user it was made for", () => {
  assert.equal(userFromToken(createSessionToken("  Ada ")), "ada");
});

test("a token that is not ours names nobody", () => {
  assert.equal(userFromToken("bearer:ada"), null);
});

test("the session lifetime defaults and is capped", () => {
  assert.equal(sessionDurationSeconds(), 3600);
  assert.equal(sessionDurationSeconds(10 ** 9), 86400);
});

test("a session ends when its lifetime has passed", () => {
  assert.equal(isSessionValid(0, 1000, 60), true);
  assert.equal(isSessionValid(0, 61_000, 60), false);
});

test("a weak password is explained", () => {
  assert.match(passwordProblem("short"), /at least 12/);
  assert.equal(passwordProblem("Longenough1Password"), null);
});

test("logging in returns a token", () => {
  assert.equal(loginHandler({ userId: "Ada" }).token, "token:ada");
});
