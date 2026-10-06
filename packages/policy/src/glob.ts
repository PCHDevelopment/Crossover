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

/** Whole-string match of a single wildcard pattern (`*`, `?`) against `text`. */
function wildcardMatch(pattern: string, text: string): boolean {
  // Iterative two-pointer matching with one backtrack point: O(pattern × text), no recursion.
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === "*") {
      starP = p++;
      starT = t;
    } else if (starP !== -1) {
      p = starP + 1;
      t = ++starT;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
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
