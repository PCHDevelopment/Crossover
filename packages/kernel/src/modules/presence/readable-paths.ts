/** Filter path names through the reader's policy while checking each distinct path once. */
export async function filterReadablePaths(
  paths: readonly string[],
  canRead: (path: string) => Promise<boolean>,
): Promise<string[]> {
  const cache = new Map<string, boolean>();
  const readable: string[] = [];
  for (const path of paths) {
    let allowed = cache.get(path);
    if (allowed === undefined) {
      allowed = await canRead(path);
      cache.set(path, allowed);
    }
    if (allowed) readable.push(path);
  }
  return readable;
}
