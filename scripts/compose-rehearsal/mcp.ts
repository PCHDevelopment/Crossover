import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { BASE_URL } from "./harness.js";

interface ToolResult {
  isError?: boolean;
  content?: { text?: string }[];
  structuredContent?: unknown;
}

export interface AgentMcp {
  name: string;
  tools: string[];
  call<T>(tool: string, args: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

/**
 * An agent's MCP session the way Claude Code has it: `room … mcp` as a child process, speaking
 * newline-delimited JSON-RPC on stdio, with that agent's own config file. Tool names come from
 * `tools/list`; a name the runbook uses that the server doesn't list fails the call naming it.
 */
export async function connectAgent(
  name: string,
  configPath: string,
  roomId: string,
): Promise<AgentMcp> {
  const transport = new StdioClientTransport({
    command: process.env["ROOM_BIN"] ?? "room",
    args: ["--server", BASE_URL, "--room", roomId, "mcp"],
    env: { ...getDefaultEnvironment(), CROSSOVER_CONFIG: configPath },
    stderr: "pipe",
  });
  const client = new Client({ name: `compose-rehearsal-${name}`, version: "1.0.0" });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  return {
    name,
    tools,
    async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
      if (!tools.includes(tool)) {
        throw new Error(
          `${name}: the runbook's MCP tool "${tool}" is not in tools/list (listed: ${tools.join(", ")})`,
        );
      }
      const result = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
      if (result.isError) {
        throw new Error(
          `${name}: MCP ${tool} failed: ${result.content?.map((c) => c.text).join("\n")}`,
        );
      }
      if (typeof result.structuredContent === "object" && result.structuredContent !== null)
        return result.structuredContent as T;
      throw new Error(`${name}: MCP ${tool} returned no structured result`);
    },
    close: () => client.close(),
  };
}
