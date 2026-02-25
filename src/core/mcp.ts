import { parse } from "smol-toml";

export interface McpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpServersConfig {
  mcpServers?: Record<string, McpServer>;
}

interface CodexConfig {
  mcp_servers?: Record<string, McpServer>;
  mcpServers?: Record<string, McpServer>;
}

export interface McpExtractResult {
  mcpServers: Record<string, McpServer> | null;
  warnings: string[];
}

const PATH_PATTERN = /^(\/|\.\/|\.\.\/|~\/)/;

export async function extractMcpServers(configPath: string): Promise<McpExtractResult> {
  try {
    const content = (await Bun.file(configPath).json()) as McpServersConfig;
    const mcpServers = content.mcpServers ?? null;
    const warnings = mcpServers ? detectProblematicPaths(mcpServers) : [];
    return { mcpServers, warnings };
  } catch {
    return { mcpServers: null, warnings: [] };
  }
}

export async function detectCodexMcpPathWarnings(configPath: string): Promise<string[]> {
  try {
    const raw = await Bun.file(configPath).text();
    const parsed = parse(raw) as unknown as CodexConfig;
    const mcpServers = parsed.mcp_servers ?? parsed.mcpServers ?? null;

    if (!mcpServers) {
      return [];
    }

    return detectProblematicPaths(mcpServers);
  } catch {
    return [];
  }
}

export function mergeMcpServers(existingRaw: string, incomingRaw: string): string {
  const existing = safeParseJson(existingRaw);
  const incoming = safeParseJson(incomingRaw) as McpServersConfig;

  const merged = {
    ...existing,
    mcpServers: {
      ...(isRecord(existing.mcpServers) ? existing.mcpServers : {}),
      ...(incoming.mcpServers ?? {}),
    },
  };

  return JSON.stringify(merged, null, 2);
}

function detectProblematicPaths(mcpServers: Record<string, McpServer>): string[] {
  const warnings: string[] = [];

  for (const [name, server] of Object.entries(mcpServers)) {
    if (typeof server.command === "string" && PATH_PATTERN.test(server.command)) {
      warnings.push(`${name}: command "${server.command}" is a path`);
    }

    for (const arg of server.args ?? []) {
      if (PATH_PATTERN.test(arg)) {
        warnings.push(`${name}: arg "${arg}" is a path`);
      }
    }
  }

  return warnings;
}

function safeParseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    return {};
  }

  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
