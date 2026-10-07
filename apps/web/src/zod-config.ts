import { z } from "zod";

// The page forbids `eval` (Content-Security-Policy): zod must not probe for it. Imported first,
// before any schema is built.
z.config({ jitless: true });
