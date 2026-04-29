import { readFile } from "node:fs/promises";
import { basename } from "node:path";
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

export interface CodexMcpCommandCandidate {
  name: string;
  command: string;
  binaryName: string;
}

export interface CodexMcpCommandNormalization {
  content: string;
  changes: string[];
  warnings: string[];
}

const PATH_PATTERN = /^(\/|\.\/|\.\.\/|~\/)/;

export async function extractMcpServers(configPath: string): Promise<McpExtractResult> {
  try {
    const raw = await readFile(configPath, "utf8");
    const content = JSON.parse(raw) as McpServersConfig;
    const mcpServers = content.mcpServers ?? null;
    const warnings = mcpServers ? detectProblematicPaths(mcpServers) : [];
    return { mcpServers, warnings };
  } catch {
    return { mcpServers: null, warnings: [] };
  }
}

export async function detectCodexMcpPathWarnings(configPath: string): Promise<string[]> {
  try {
    const raw = await readFile(configPath, "utf8");
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

export function getCodexMcpCommandPathCandidates(rawConfig: string): CodexMcpCommandCandidate[] {
  const parsed = parse(rawConfig) as unknown as CodexConfig;
  const mcpServers = parsed.mcp_servers ?? parsed.mcpServers ?? null;

  if (!mcpServers) {
    return [];
  }

  const candidates: CodexMcpCommandCandidate[] = [];

  for (const [name, server] of Object.entries(mcpServers)) {
    if (typeof server.command === "string" && PATH_PATTERN.test(server.command)) {
      candidates.push({
        name,
        command: server.command,
        binaryName: basename(server.command),
      });
    }
  }

  return candidates;
}

export async function normalizeCodexMcpCommandPaths(
  rawConfig: string,
  resolveCommandPath: (binaryName: string) => Promise<string | null>,
): Promise<CodexMcpCommandNormalization> {
  const changes: string[] = [];
  const warnings: string[] = [];
  let content = rawConfig;

  for (const candidate of getCodexMcpCommandPathCandidates(rawConfig)) {
    const resolvedCommand = await resolveCommandPath(candidate.binaryName);

    if (!resolvedCommand) {
      warnings.push(`${candidate.name}: ${candidate.binaryName} not found on remote`);
      continue;
    }

    if (resolvedCommand === candidate.command) {
      continue;
    }

    const nextContent = replaceCodexMcpCommand(
      content,
      candidate.name,
      candidate.command,
      resolvedCommand,
    );

    if (nextContent === content) {
      warnings.push(`${candidate.name}: could not rewrite command "${candidate.command}"`);
      continue;
    }

    content = nextContent;
    changes.push(`${candidate.name}: ${candidate.command} -> ${resolvedCommand}`);
  }

  return { content, changes, warnings };
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

function replaceCodexMcpCommand(
  rawConfig: string,
  serverName: string,
  oldCommand: string,
  newCommand: string,
): string {
  const sectionPattern = new RegExp(
    `(^\\[mcp_servers\\.${escapeRegExp(serverName)}\\]\\n)([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`,
    "m",
  );
  const sectionMatch = rawConfig.match(sectionPattern);

  if (!sectionMatch) {
    return rawConfig;
  }

  const [section, header = "", body = ""] = sectionMatch;
  const commandPattern = new RegExp(
    `(^\\s*command\\s*=\\s*)${escapeRegExp(JSON.stringify(oldCommand))}(\\s*(?:#.*)?$)`,
    "m",
  );
  const nextBody = body.replace(commandPattern, `$1${JSON.stringify(newCommand)}$2`);

  if (nextBody === body) {
    return rawConfig;
  }

  return rawConfig.replace(section, `${header}${nextBody}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
