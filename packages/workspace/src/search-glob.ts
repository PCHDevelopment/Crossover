/** Convert the deliberately small gitignore-style search glob subset to a path regexp. */
export function globToRegExpSource(glob: string): string | null {
  if (["[", "]", "{", "}", "\\"].some((char) => glob.includes(char)) || glob.startsWith("!"))
    return null;

  const hasSlash = glob.includes("/");
  const pattern = hasSlash ? glob.replace(/^\//, "") : glob;
  let body = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*" && pattern[i + 1] === "*") {
      const atSegmentStart = i === 0 || pattern[i - 1] === "/";
      const atSegmentEnd = i + 2 === pattern.length || pattern[i + 2] === "/";
      if (!atSegmentStart || !atSegmentEnd) return null;
      i += 1;
      if (pattern[i + 1] === "/") {
        i += 1;
        body += "(?:.*/)?";
      } else if (i === pattern.length - 1) {
        body += ".*";
      } else {
        body += ".*";
      }
    } else if (char === "*") {
      body += "[^/]*";
    } else if (char === "?") {
      body += "[^/]";
    } else {
      body += char.replace(/[.+^$()|]/g, "\\$&");
    }
  }

  return hasSlash ? `^${body}$` : `(?:^|/)${body}$`;
}

/** Match the supported glob subset in bounded time, including repeated wildcards. */
export function globMatchesPath(glob: string, path: string): boolean {
  if (globToRegExpSource(glob) === null) return false;
  const pattern = glob.includes("/") ? glob.replace(/^\//, "") : glob;
  const target = glob.includes("/") ? path : path.slice(path.lastIndexOf("/") + 1);
  const tokens: string[] = [];
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern.startsWith("**/", i)) {
      tokens.push("**/");
      i += 2;
    } else if (pattern.startsWith("**", i)) {
      tokens.push("**");
      i += 1;
    } else {
      tokens.push(pattern[i]!);
    }
  }

  let next = new Uint8Array(target.length + 1);
  next[target.length] = 1;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i]!;
    const current = new Uint8Array(target.length + 1);
    let suffixAfterSlash = false;
    for (let j = target.length; j >= 0; j -= 1) {
      const char = target[j];
      if (token === "**/") {
        if (char === "/" && next[j + 1]) suffixAfterSlash = true;
        current[j] = next[j] || suffixAfterSlash ? 1 : 0;
      } else if (token === "**") {
        current[j] = next[j] || (j < target.length && current[j + 1]) ? 1 : 0;
      } else if (token === "*") {
        current[j] = next[j] || (j < target.length && char !== "/" && current[j + 1]) ? 1 : 0;
      } else if (j < target.length && (token === "?" ? char !== "/" : char === token)) {
        current[j] = next[j + 1]!;
      }
    }
    next = current;
  }
  return next[0] === 1;
}
