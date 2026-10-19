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
