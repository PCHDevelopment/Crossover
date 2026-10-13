const isBidi = (code: number) =>
  (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);

const MAX_PENDING_CONTROL_SEQUENCE_LENGTH = 4 * 1024;

function isUnsafeTextControl(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    isBidi(code)
  );
}

function asSafeText(text: string): string {
  let output = "";
  for (let index = 0; index < text.length; index++) {
    if (!isUnsafeTextControl(text.charCodeAt(index))) output += text[index];
  }
  return output;
}

function controlEnd(text: string, index: number): number | undefined {
  const escaped = text.charCodeAt(index) === 0x1b;
  const intro = text.charCodeAt(index + (escaped ? 1 : 0));
  if (Number.isNaN(intro)) return undefined;
  let cursor = index + (escaped ? 2 : 1);
  if (intro === 0x5b || intro === 0x9b) {
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor++);
      if (code >= 0x40 && code <= 0x7e) return cursor;
      if (code < 0x20 || code > 0x3f) return cursor;
    }
    return undefined;
  }
  if ([0x5d, 0x50, 0x58, 0x5e, 0x5f, 0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(intro)) {
    const osc = intro === 0x5d || intro === 0x9d;
    for (; cursor < text.length; cursor++) {
      const code = text.charCodeAt(cursor);
      if (code === 0x9c || (osc && code === 0x07)) return cursor + 1;
      if (code === 0x1b) {
        if (cursor + 1 === text.length) return undefined;
        if (text.charCodeAt(cursor + 1) === 0x5c) return cursor + 2;
      }
    }
    return undefined;
  }
  if (escaped && intro >= 0x20 && intro <= 0x2f) {
    while (
      cursor < text.length &&
      text.charCodeAt(cursor) >= 0x20 &&
      text.charCodeAt(cursor) <= 0x2f
    )
      cursor++;
    return cursor < text.length ? cursor + 1 : undefined;
  }
  return cursor;
}

/** Filters terminal and direction controls, carrying incomplete escape sequences between chunks. */
export class TerminalTextSanitizer {
  private pending = "";

  write(chunk: string): string {
    const text = this.pending + chunk;
    this.pending = "";
    let output = "";
    for (let index = 0; index < text.length;) {
      const code = text.charCodeAt(index);
      if (code === 0x1b || [0x90, 0x98, 0x9b, 0x9d, 0x9e, 0x9f].includes(code)) {
        const end = controlEnd(text, index);
        if (end === undefined) {
          const pending = text.slice(index);
          if (pending.length > MAX_PENDING_CONTROL_SEQUENCE_LENGTH) {
            // Once the cap is crossed, stop treating the tail as a control
            // sequence. Drop its introducer and surface the remainder as text.
            const introducerLength = code === 0x1b ? Math.min(2, pending.length) : 1;
            output += asSafeText(pending.slice(introducerLength));
          } else this.pending = pending;
          break;
        }
        index = end;
      } else if (isUnsafeTextControl(code)) index++;
      else output += text[index++];
    }
    return output;
  }

  finish(): void {
    this.pending = "";
  }
}

export function sanitizeTerminalText(text: string): string {
  const sanitizer = new TerminalTextSanitizer();
  const output = sanitizer.write(text);
  sanitizer.finish();
  return output;
}
