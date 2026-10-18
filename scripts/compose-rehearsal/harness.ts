import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const BASE_URL = process.env["REHEARSAL_BASE_URL"] ?? "http://localhost:8080";
export const OUT_DIR = process.env["REHEARSAL_OUT"] ?? "rehearsal-out";
export const REPO_ROOT = process.env["REHEARSAL_ROOT"] ?? process.cwd();

/** Values that must never appear in the step log or the server log (labelled, never printed). */
const secrets = new Map<string, string>();

/** Remember a secret so the leak check can look for it; returns it unchanged. */
export function secret(label: string, value: string): string {
  if (value.length >= 8) secrets.set(value, label);
  return value;
}

/** Remember every long string in a JSON file (an agent's config holds its tokens). */
export async function secretsFromJsonFile(label: string, path: string): Promise<void> {
  const walk = (value: unknown, key: string) => {
    if (typeof value === "string") secret(`${label}.${key}`, value);
    else if (value && typeof value === "object")
      for (const [name, inner] of Object.entries(value)) walk(inner, `${key}.${name}`);
  };
  walk(JSON.parse(await readFile(path, "utf8")), "");
}

let stepLog = "";
const results: { id: string; ok: boolean; ms: number }[] = [];

async function emit(line: string): Promise<void> {
  process.stdout.write(`${line}\n`);
  stepLog += `${line}\n`;
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "steps.log"), stepLog);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The last `lines` lines of `docker compose logs server`, for a failure report. */
export async function serverLogTail(lines = 200): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["compose", "logs", "--no-color", "--tail", String(lines), "server"],
      { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    return `(could not read the server log: ${errorText(error)})`;
  }
}

export interface StepInfo {
  /** The runbook step, for the report: "5", "0b". */
  id: string;
  /** What DEMO-RUNBOOK.md says the step does. */
  title: string;
  /** The runbook's expectation, which the step asserts. */
  expectation: string;
  budgetMs: number;
}

/**
 * Run one step: a line `step N  PASS|FAIL  <ms>  <detail>` either way. A step that fails prints the
 * runbook step, the expectation, what was observed and the tail of the server log, then stops the
 * rehearsal by throwing.
 */
export async function step(info: StepInfo, run: () => Promise<string | void>): Promise<void> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const detail = await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no result within the step's budget of ${info.budgetMs} ms`)),
          info.budgetMs,
        );
      }),
    ]);
    const ms = Date.now() - started;
    results.push({ id: info.id, ok: true, ms });
    await emit(`step ${info.id.padEnd(3)} PASS  ${ms}  ${detail ?? info.title}`);
  } catch (error) {
    const ms = Date.now() - started;
    results.push({ id: info.id, ok: false, ms });
    await emit(`step ${info.id.padEnd(3)} FAIL  ${ms}  ${info.title}`);
    await emit(`  runbook step : ${info.id} (${info.title})`);
    await emit(`  expected     : ${info.expectation}`);
    await emit(`  observed     : ${errorText(error)}`);
    await emit(`  last 200 lines of docker compose logs server:`);
    await emit(await serverLogTail(200));
    throw new Error(`step ${info.id} failed: ${errorText(error)}`, { cause: error });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The closing summary line of the rehearsal. */
export async function summary(skipped: string[]): Promise<void> {
  const failed = results.filter((result) => !result.ok).length;
  const total = results.reduce((sum, result) => sum + result.ms, 0);
  await emit(
    `summary ${results.length - failed}/${results.length} steps passed, ${total} ms in steps` +
      (skipped.length ? `; not run: ${skipped.join("; ")}` : ""),
  );
}

/**
 * Fail if a registered secret is in any file of `paths` (files, or directories of files). Only the
 * label of a leaked secret is reported, never its value.
 */
export async function assertNoLeaks(paths: string[]): Promise<string> {
  const files: string[] = [];
  for (const path of paths) {
    try {
      for (const name of await readdir(path)) files.push(join(path, name));
    } catch {
      files.push(path);
    }
  }
  const leaks: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const [value, label] of secrets)
      if (text.includes(value)) leaks.push(`${label} in ${file}`);
  }
  if (leaks.length) throw new Error(`secrets found in the logs: ${leaks.join(", ")}`);
  return `${secrets.size} secrets checked in ${files.length} files`;
}

/** Poll until `read` returns a value `ready` accepts; the message names what was last seen. */
export async function waitFor<T>(
  what: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = "nothing observed";
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (ready(value)) return value;
      last = (JSON.stringify(value) ?? String(value)).slice(0, 300);
    } catch (error) {
      last = errorText(error).slice(0, 300);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${what}: not ready in ${timeoutMs} ms; last observation: ${last}`);
}
