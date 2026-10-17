/**
 * Glob matching for capability scopes.
 *
 * Two flavours, because scopes mean different things:
 * - **path globs** (workspace paths), gitignore-style: `*` and `?` never match `/`; a
 *   trailing `/**` matches one or more segments *below* the directory (not the directory
 *   itself); a leading or middle `**` segment matches zero or more directories. Wildcards
 *   DO match dotfiles: a grant of `src/**` covers `src/.env`.
 * - **plain globs** (everything else: `org/repo`, ARNs, `function/staging-*`), IAM-style: `*`
 *   matches any run of characters, `/` and `:` included, and `?` matches exactly one.
 *
 * Nothing else is special: `[`, `]`, `{`, `}`, `!` and `\` are literal characters. Matching
 * is case-sensitive and always against the whole string.
 */

/** Length in code points, as Rego's `count()` sees a string (`.length` counts UTF-16 units). */
export function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    count++;
    const high = text.charCodeAt(i);
    if (high >= 0xd800 && high <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) i++;
    }
  }
  return count;
}

/**
 * Whole-string match of a single wildcard pattern (`*`, `?`) against `text`. `?` matches one
 * code point, as it does in Rego (an emoji is one character, though two UTF-16 units).
 */
export function wildcardMatch(pattern: string, text: string): boolean {
  const pat = Array.from(pattern);
  const str = Array.from(text);
  // Iterative two-pointer matching with one backtrack point: O(pattern × text), no recursion.
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < str.length) {
    // A `*` in the pattern is always a wildcard, even where the text has a `*` there too.
    if (p < pat.length && pat[p] === "*") {
      starP = p++;
      starT = t;
    } else if (p < pat.length && (pat[p] === "?" || pat[p] === str[t])) {
      p++;
      t++;
    } else if (starP !== -1) {
      p = starP + 1;
      t = ++starT;
    } else {
      return false;
    }
  }
  while (p < pat.length && pat[p] === "*") p++;
  return p === pat.length;
}

/** IAM-style: `*` and `?` match any characters, separators included. */
export function plainGlobMatch(pattern: string, text: string): boolean {
  return wildcardMatch(pattern, text);
}

/** gitignore-style path glob over `/`-separated segments. */
export function pathGlobMatch(pattern: string, path: string): boolean {
  const pat = pattern.split("/");
  const segs = path.split("/");
  const memo = new Map<number, boolean>();

  const match = (pi: number, si: number): boolean => {
    const key = pi * (segs.length + 1) + si;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (pi === pat.length) {
      result = si === segs.length;
    } else if (pat[pi] === "**") {
      if (pi === pat.length - 1) {
        // Trailing `**`: everything below, but at least one segment.
        result = si < segs.length;
      } else {
        // Leading or middle `**`: zero or more whole segments.
        result = false;
        for (let k = si; k <= segs.length && !result; k++) result = match(pi + 1, k);
      }
    } else {
      result = si < segs.length && wildcardMatch(pat[pi]!, segs[si]!) && match(pi + 1, si + 1);
    }
    memo.set(key, result);
    return result;
  };

  return match(0, 0);
}
