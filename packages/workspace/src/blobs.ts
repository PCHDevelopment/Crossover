import { git } from "./git.js";

export async function blobsAt(
  repo: string,
  tree: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (let offset = 0; offset < paths.length; offset += 32) {
    const batch = paths.slice(offset, offset + 32);
    const { stdout } = await git(["ls-tree", "-rz", "--full-tree", tree, "--", ...batch], {
      gitDir: repo,
      timeoutMs: 10_000,
      env: { GIT_LITERAL_PATHSPECS: "1" },
    });
    for (const record of stdout.split("\0")) {
      if (!record) continue;
      const tab = record.indexOf("\t");
      const [mode, type, oid] = record.slice(0, tab).split(" ");
      const path = record.slice(tab + 1);
      if (type === "blob" && (mode === "100644" || mode === "100755") && oid) result.set(path, oid);
    }
  }
  return result;
}

export async function blobSizes(repo: string, oids: readonly string[]): Promise<Map<string, number>> {
  const unique = [...new Set(oids)];
  const sizes = new Map<string, number>();
  if (unique.length) {
    const { stdout } = await git(["cat-file", "--batch-check"], {
      gitDir: repo,
      timeoutMs: 10_000,
      input: `${unique.join("\n")}\n`,
    });
    const lines = stdout.trimEnd().split("\n");
    if (lines.length !== unique.length) throw new Error("Malformed source blob size response");
    for (const [index, line] of lines.entries()) {
      const [oid, type, sizeText] = line.split(" ");
      const size = Number(sizeText);
      if (
        oid === undefined ||
        oid !== unique[index] ||
        type !== "blob" ||
        !Number.isSafeInteger(size)
      )
        throw new Error("Unexpected source blob size response");
      sizes.set(oid, size);
    }
  }
  return sizes;
}

export async function readBlobs(
  repo: string,
  oids: readonly string[],
  sizes: ReadonlyMap<string, number>,
): Promise<Map<string, Buffer>> {
  const unique = [...new Set(oids)];
  const contents = new Map<string, Buffer>();
  for (let offset = 0; offset < unique.length;) {
    let end = offset;
    let bytes = 0;
    while (
      end < unique.length &&
      (end === offset || bytes + sizes.get(unique[end]!)! <= 24 * 1024 * 1024)
    ) {
      bytes += sizes.get(unique[end]!)! + 128;
      end++;
    }
    const batch = unique.slice(offset, end);
    const { stdout } = await git(["cat-file", "--batch"], {
      gitDir: repo,
      timeoutMs: 10_000,
      input: `${batch.join("\n")}\n`,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
    });
    let cursor = 0;
    for (const expected of batch) {
      const newline = stdout.indexOf(0x0a, cursor);
      if (newline < 0) throw new Error("Malformed source blob batch");
      const [oid, type, sizeText] = stdout.subarray(cursor, newline).toString("ascii").split(" ");
      const size = Number(sizeText);
      const start = newline + 1;
      if (oid !== expected || type !== "blob" || size !== sizes.get(expected))
        throw new Error("Unexpected source blob batch result");
      contents.set(oid, stdout.subarray(start, start + size));
      cursor = start + size;
      if (stdout[cursor] !== 0x0a) throw new Error("Malformed source blob batch separator");
      cursor++;
    }
    offset = end;
  }
  return contents;
}

