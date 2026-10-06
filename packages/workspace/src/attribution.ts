import { git } from "./git.js";

/** Internal ranges only: command handlers translate object IDs to workspace revisions (§9.1). */
export async function attribution(repo: string, commit: string, path: string) {
  const { stdout } = await git(
    ["blame", "--incremental", "--root", "--no-textconv", commit, "--", path],
    { gitDir: repo, timeoutMs: 10_000 },
  );
  return stdout.split("\n").flatMap((line) => {
    const match = /^([0-9a-f]{40,64}) (\d+) (\d+) (\d+)$/.exec(line);
    return match ? [{ commit: match[1]!, start: Number(match[3]), count: Number(match[4]) }] : [];
  });
}
