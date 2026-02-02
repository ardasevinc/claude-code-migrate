interface McpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpServersConfig {
  mcpServers?: Record<string, McpServer>;
}

export interface McpExtractResult {
  mcpServers: Record<string, McpServer> | null;
  warnings: string[];
}

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

function detectProblematicPaths(mcpServers: Record<string, McpServer>): string[] {
  const warnings: string[] = [];
  const pathPattern = /^(\/|\.\/|\.\.\/|~\/)/;

  for (const [name, server] of Object.entries(mcpServers)) {
    // Check command
    if (pathPattern.test(server.command)) {
      warnings.push(`${name}: command "${server.command}" is a path`);
    }

    // Check args
    for (const arg of server.args ?? []) {
      if (pathPattern.test(arg)) {
        warnings.push(`${name}: arg "${arg}" is a path`);
      }
    }
  }

  return warnings;
}
