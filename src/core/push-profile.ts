import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CodexPluginPolicy,
  FileEntry,
  HostProfile,
  ProviderName,
  StructuredPatch,
} from "../types/index.ts";
import { BlockedError } from "../errors.ts";
import { captureProfileAssets, type CapturedProfileAsset } from "./profile-assets.ts";
import {
  decodeStructuredJson,
  decodeStructuredToml,
  encodeStructuredJson,
  encodeStructuredToml,
} from "./structured-codec.ts";
import { applyStructuredPatch, assertCodexProfilePatchAllowed } from "./structured-patch.ts";

export interface ResolvedPushProfile {
  readonly name: string;
  readonly host: string;
  readonly configDir: string;
  readonly definition: HostProfile;
  readonly assets: readonly CapturedProfileAsset[];
  readonly effectCodes: ReadonlyMap<string, string>;
  readonly warnings: readonly string[];
  readonly pluginPolicies: Readonly<Record<string, CodexPluginPolicy>>;
}

export interface AppliedPushProfile {
  readonly files: readonly FileEntry[];
  readonly profile: ResolvedPushProfile;
}

export function applyResolvedCodexProfile(
  bytes: Uint8Array | undefined,
  profile: ResolvedPushProfile | undefined,
): Uint8Array | undefined {
  const patch = profile?.definition.codex?.config;
  if (!patch) return bytes;
  assertCodexProfilePatchAllowed(patch);
  const document = decodeStructuredToml(bytes ? Buffer.from(bytes).toString("utf8") : "");
  return Buffer.from(encodeStructuredToml(applyStructuredPatch(document, patch)));
}

function virtualEntry(path: string, bytes: Uint8Array, configDir: string): FileEntry {
  return {
    sourcePath: join(configDir, ".ccm-profile-virtual"),
    relativePath: path,
    isSymlink: false,
    mcpServersOnly: Buffer.from(bytes).toString("utf8"),
  };
}

function replaceEntry(
  files: readonly FileEntry[],
  path: string,
  bytes: Uint8Array,
  configDir: string,
): FileEntry[] {
  return [
    ...files.filter((file) => file.relativePath !== path).map((file) => ({ ...file })),
    virtualEntry(path, bytes, configDir),
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function entryText(files: readonly FileEntry[], path: string): Promise<string> {
  const file = files.find((candidate) => candidate.relativePath === path);
  if (!file) return "";
  return file.mcpServersOnly ?? readFile(file.sourcePath, "utf8");
}

async function patchEntry(
  files: readonly FileEntry[],
  path: "claude/settings.json" | "codex/config.toml",
  patch: StructuredPatch,
  configDir: string,
): Promise<FileEntry[]> {
  const source = await entryText(files, path);
  const isJson = path.endsWith(".json");
  const document = isJson
    ? decodeStructuredJson(source || "{}")
    : decodeStructuredToml(source || "");
  const patched = applyStructuredPatch(document, patch);
  const encoded = isJson ? encodeStructuredJson(patched) : encodeStructuredToml(patched);
  return replaceEntry(files, path, Buffer.from(encoded), configDir);
}

function selectedDefinition(
  profile: HostProfile,
  providers: ReadonlySet<ProviderName>,
): HostProfile {
  return {
    host: profile.host,
    ...(providers.has("claude") ? { claude_md: profile.claude_md, claude: profile.claude } : {}),
    ...(providers.has("codex") ? { agents_md: profile.agents_md, codex: profile.codex } : {}),
  };
}

/** Applies a profile to a copied logical source view without editing provider files. */
export async function applyPushProfile(input: {
  readonly name: string;
  readonly definition: HostProfile;
  readonly configDir: string;
  readonly providers: readonly ProviderName[];
  readonly files: readonly FileEntry[];
}): Promise<AppliedPushProfile> {
  const providers = new Set(input.providers);
  const definition = selectedDefinition(input.definition, providers);
  if (definition.codex?.config) assertCodexProfilePatchAllowed(definition.codex.config);
  const assets = await captureProfileAssets(definition, input.configDir);
  let files = input.files.map((file) => ({ ...file }));
  const effectCodes = new Map<string, string>();
  for (const asset of assets) {
    files = replaceEntry(files, asset.destinationPath, asset.bytes, input.configDir);
    effectCodes.set(
      asset.destinationPath,
      `profile.${input.name}.${asset.kind === "claude_md" ? "claude" : "codex"}-instructions`,
    );
  }
  if (definition.claude?.settings) {
    files = await patchEntry(
      files,
      "claude/settings.json",
      definition.claude.settings,
      input.configDir,
    );
    effectCodes.set("claude/settings.json", `profile.${input.name}.claude-settings`);
  }
  const warnings: string[] = [];
  if (definition.codex?.config) {
    const existing = await entryText(files, "codex/config.toml");
    decodeStructuredToml(existing || "");
    if (!files.some((file) => file.relativePath === "codex/config.toml")) {
      files = replaceEntry(files, "codex/config.toml", Buffer.alloc(0), input.configDir);
    }
    effectCodes.set("codex/config.toml", `profile.${input.name}.codex-config`);
    warnings.push("profile-codex-config-canonicalized");
  }
  return {
    files,
    profile: Object.freeze({
      name: input.name,
      host: definition.host,
      configDir: input.configDir,
      definition,
      assets,
      effectCodes,
      warnings,
      pluginPolicies: Object.freeze({ ...(definition.codex?.plugin_policies ?? {}) }),
    }),
  };
}

export async function verifyPushProfileAssets(profile: ResolvedPushProfile): Promise<void> {
  const current = await captureProfileAssets(profile.definition, profile.configDir);
  const expected = new Map(profile.assets.map((asset) => [asset.kind, asset]));
  if (
    current.length !== profile.assets.length ||
    current.some((asset) => {
      const prior = expected.get(asset.kind);
      return !prior || prior.size !== asset.size || prior.sha256 !== asset.sha256;
    })
  ) {
    throw new BlockedError("Profile assets changed after planning");
  }
}
