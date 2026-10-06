/** Internal text operations (§10.1); patch and blob variants arrive in T504/T510. */
export type Operation =
  | { type: "create"; path: string; content: string }
  | { type: "modify"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "rename"; from: string; to: string; content?: string };
