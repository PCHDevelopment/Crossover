import { request as httpRequest } from "node:http";
import { isAbsolute } from "node:path";

const DOCKER_API_REQUEST_TIMEOUT_MS = 5_000;
const MAX_DOCKER_API_RESPONSE_BYTES = 1024 * 1024;

function extractJsonObject(source: string, property: string): string {
  const propertyMatch = new RegExp(`"${property}"\\s*:\\s*\\{`).exec(source);
  if (!propertyMatch) throw new Error(`Docker stats response is missing ${property}`);

  const objectStart = propertyMatch.index + propertyMatch[0].lastIndexOf("{");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = objectStart; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return source.slice(objectStart, index + 1);
  }
  throw new Error(`Docker stats response has an incomplete ${property} object`);
}

export function parseDockerCpuUsageUsec(statsJson: string): bigint {
  try {
    JSON.parse(statsJson);
  } catch {
    throw new Error("ERROR: Docker returned invalid container stats JSON");
  }

  const cpuUsage = extractJsonObject(extractJsonObject(statsJson, "cpu_stats"), "cpu_usage");
  const totalUsage = /"total_usage"\s*:\s*(0|[1-9][0-9]*)/.exec(cpuUsage)?.[1];
  if (totalUsage === undefined)
    throw new Error("ERROR: Docker stats response is missing CPU total_usage");
  return BigInt(totalUsage) / 1_000n;
}

export function dockerSocketPath(configuredPath?: string): string {
  if (configuredPath) {
    if (!isAbsolute(configuredPath) || configuredPath.includes("\0"))
      throw new Error("Docker CPU stats socket path must be absolute");
    return configuredPath;
  }

  const dockerHost = process.env["DOCKER_HOST"] ?? "unix:///var/run/docker.sock";
  if (!dockerHost.startsWith("unix://"))
    throw new Error("Docker CPU stats require DOCKER_HOST to use a Unix socket");
  const path = dockerHost.slice("unix://".length);
  if (!isAbsolute(path) || path.includes("\0"))
    throw new Error("Docker CPU stats require an absolute Unix socket path");
  return path;
}

function requestDockerApi(socketPath: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let responseBytes = 0;
    const chunks: Buffer[] = [];
    const request = httpRequest(
      { socketPath, path, method: "GET", timeout: DOCKER_API_REQUEST_TIMEOUT_MS },
      (response) => {
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseBytes += buffer.length;
          if (responseBytes > MAX_DOCKER_API_RESPONSE_BYTES) {
            request.destroy(new Error("Docker API response exceeded the size limit"));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (
            response.statusCode === undefined ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            reject(
              new Error(`Docker API ${path} returned HTTP ${response.statusCode ?? "unknown"}`),
            );
            return;
          }
          resolve(body);
        });
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error("Docker API request timed out")));
    request.on("error", reject);
    request.end();
  });
}

export async function readDockerCpuUsageUsec(
  containerRef: string,
  socketPath: string,
): Promise<bigint> {
  const versionBody = await requestDockerApi(socketPath, "/version");
  let apiVersion: unknown;
  try {
    apiVersion = (JSON.parse(versionBody) as { ApiVersion?: unknown }).ApiVersion;
  } catch {
    throw new Error("ERROR: Docker returned invalid API version JSON");
  }
  if (typeof apiVersion !== "string" || !/^\d+\.\d+$/.test(apiVersion))
    throw new Error("ERROR: Docker returned an invalid API version");

  const [majorText, minorText] = apiVersion.split(".");
  const supportsOneShot =
    Number(majorText) > 1 || (Number(majorText) === 1 && Number(minorText) >= 41);
  const oneShot = supportsOneShot ? "&one-shot=true" : "";
  const encodedContainerRef = encodeURIComponent(containerRef);
  const stats = await requestDockerApi(
    socketPath,
    `/v${apiVersion}/containers/${encodedContainerRef}/stats?stream=false${oneShot}`,
  );
  return parseDockerCpuUsageUsec(stats);
}
