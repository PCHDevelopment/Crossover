import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export interface StaticFile {
  body: Buffer;
  type: string;
  /** A fingerprinted build asset: cacheable forever. */
  immutable: boolean;
}

/**
 * Serve a built single-page app from `root` (T1104): a file under it by its path, `index.html`
 * for any other path that doesn't look like a file (the app's own routes). Nothing outside `root`
 * is reachable (the path is decoded, normalized and must stay inside it), and nothing under `/v1/`
 * is served from here.
 */
export function staticSite(root: string): (url: string) => Promise<StaticFile | undefined> {
  const base = resolve(root);
  const read = async (path: string): Promise<Buffer | undefined> => {
    const full = resolve(join(base, normalize(path)));
    if (full !== base && !full.startsWith(base + sep)) return undefined;
    try {
      return await readFile(full);
    } catch {
      return undefined;
    }
  };
  return async (url) => {
    let path: string;
    try {
      path = decodeURIComponent(url.split(/[?#]/, 1)[0] ?? "/");
    } catch {
      return undefined;
    }
    if (path.includes("\0") || path.startsWith("/v1/") || path === "/v1") return undefined;
    const ext = extname(path);
    if (ext !== "" && ext !== ".html") {
      const body = await read(path);
      const type = TYPES[ext];
      return body && type ? { body, type, immutable: path.startsWith("/assets/") } : undefined;
    }
    // The app's own routes (and `/`, `/index.html`).
    const body = await read("index.html");
    return body ? { body, type: TYPES[".html"]!, immutable: false } : undefined;
  };
}
