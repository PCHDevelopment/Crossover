export type ContentEncoding = "utf8" | "base64";
type Content = { content: string | Buffer; encoding?: ContentEncoding | undefined };
/** Internal operations (§10.1); Buffer content is used only inside the Git engine. */
export type Operation =
  | ({ type: "create"; path: string } & Content)
  | ({ type: "modify"; path: string } & (
      (Content & { patch?: never }) | { patch: string; content?: never; encoding?: never }
    ))
  | { type: "delete"; path: string }
  | {
      type: "rename";
      from: string;
      to: string;
      content?: string | Buffer;
      encoding?: ContentEncoding | undefined;
    };
