import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./git.js";

const options = { timeoutMs: 10_000 };
const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];

/** Clone through file:// so Git honors depth, as the production fetcher does over HTTPS. */
export async function cloneDepthOneUpstream(source: string, destination: string, bare = false) {
  await git(
    [
      "clone",
      "--quiet",
      "--depth=1",
      "--single-branch",
      "--no-tags",
      "--template=",
      "--branch=main",
      ...(bare ? ["--bare"] : []),
      `file://${source}`,
      destination,
    ],
    options,
  );
}

/** Build the three-commit source used by shallow room consumer tests. */
export async function createThreeCommitUpstream(root: string) {
  const upstream = join(root, "upstream");
  await mkdir(root, { recursive: true });
  await git(["init", "--quiet", "--initial-branch=main", upstream], options);
  for (const n of [1, 2, 3]) {
    await writeFile(join(upstream, `file${n}.txt`), `contents ${n}\n`);
    await git(["add", "."], { ...options, cwd: upstream });
    await git([...identity, "commit", "--quiet", "-m", `c${n}`], {
      ...options,
      cwd: upstream,
    });
  }
  const tip = (await git(["rev-parse", "HEAD"], { ...options, cwd: upstream })).stdout.trim();
  return { upstream, tip };
}

/** Reproduce git.import's shallow upstream boundary and separate canonical history. */
export async function createShallowRoomFixture(root: string) {
  const { upstream, tip } = await createThreeCommitUpstream(root);
  const fetched = join(root, "fetched");
  await cloneDepthOneUpstream(upstream, fetched);
  const repository = join(root, "room.git");
  await git(["init", "--quiet", "--bare", "--initial-branch=main", repository], options);
  const inRoom = { ...options, gitDir: repository };
  await git(
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--update-shallow",
      fetched,
      "+refs/heads/main:refs/upstream/head",
    ],
    inRoom,
  );
  const tree = (await git(["rev-parse", "refs/upstream/head^{tree}"], inRoom)).stdout.trim();
  const empty = (
    await git(["hash-object", "-t", "tree", "-w", "--stdin"], { ...inRoom, input: "" })
  ).stdout.trim();
  const initial = (
    await git([...identity, "commit-tree", empty, "-m", "room"], inRoom)
  ).stdout.trim();
  const canonical = (
    await git([...identity, "commit-tree", tree, "-p", initial, "-m", "import"], inRoom)
  ).stdout.trim();
  await git(["update-ref", "refs/room/canonical", canonical], inRoom);
  const shallow = (await readFile(join(repository, "shallow"), "utf8")).trim().split("\n");
  if (!shallow.includes(tip)) throw new Error("room fixture must retain the shallow upstream tip");
  return { root, upstream, fetched, repository, tip, initial, canonical };
}
