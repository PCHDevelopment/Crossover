/** Room Protocol major version; REST paths are prefixed `/v1/` (ARCHITECTURE §16.4). */
export const PROTOCOL_VERSION = 1;

export * from "./canonical.js";
export * from "./commands.js";
export * from "./errors.js";
export * from "./events.js";
export * from "./ids.js";
export * from "./protected-paths.js";
