/** Internal text operations (§10.1); blob variants arrive in T510. */
export type Operation =
  | { type: "create"; path: string; content: string }
  | ({ type: "modify"; path: string } & (
      { content: string; patch?: never } | { patch: string; content?: never }
    ))
  | { type: "delete"; path: string }
  | { type: "rename"; from: string; to: string; content?: string };
