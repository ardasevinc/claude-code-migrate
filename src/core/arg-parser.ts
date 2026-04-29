import { isProviderName, PROVIDER_NAMES } from "../config/providers.ts";
import type { Config, ProviderName } from "../types/index.ts";

interface PushResolution {
  providers: ProviderName[];
  target?: string;
}

interface BackupResolution {
  providers: ProviderName[];
  output?: string;
}

interface PushArgumentOptions {
  all?: boolean;
  providers?: string;
}

export function getEnabledProviders(config: Config): ProviderName[] {
  const providers: ProviderName[] = [];

  if (config.providers.claude.enabled) {
    providers.push("claude");
  }

  if (config.providers.codex.enabled) {
    providers.push("codex");
  }

  return providers;
}

function requireEnabledProviders(enabledProviders: ProviderName[]): ProviderName[] {
  if (enabledProviders.length === 0) {
    throw new Error("No providers are enabled in config.toml");
  }

  return enabledProviders;
}

function parseProviderList(rawProviders: string): ProviderName[] {
  const providers = rawProviders
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean);

  if (providers.length === 0) {
    throw new Error("--providers requires at least one provider");
  }

  const uniqueProviders: ProviderName[] = [];
  for (const provider of providers) {
    if (!isProviderName(provider)) {
      throw new Error(`Unknown provider '${provider}'. Valid providers: claude, codex`);
    }

    if (!uniqueProviders.includes(provider)) {
      uniqueProviders.push(provider);
    }
  }

  return uniqueProviders;
}

export function resolvePushArguments(
  arg1: string | undefined,
  arg2: string | undefined,
  enabledProviders: ProviderName[],
  options: PushArgumentOptions = {},
): PushResolution {
  const defaults = requireEnabledProviders(enabledProviders);

  if (options.all && options.providers) {
    throw new Error("Use either --all or --providers, not both");
  }

  if (options.all) {
    if (arg1 && isProviderName(arg1)) {
      throw new Error("Do not combine --all with a positional provider");
    }

    if (arg2) {
      throw new Error("Unexpected second argument with --all");
    }

    return { providers: PROVIDER_NAMES, target: arg1 };
  }

  if (options.providers) {
    if (arg1 && isProviderName(arg1)) {
      throw new Error("Do not combine --providers with a positional provider");
    }

    if (arg2) {
      throw new Error("Unexpected second argument with --providers");
    }

    return { providers: parseProviderList(options.providers), target: arg1 };
  }

  if (!arg1) {
    if (arg2) {
      throw new Error("Unexpected second argument");
    }

    return { providers: defaults };
  }

  if (isProviderName(arg1)) {
    return { providers: [arg1], target: arg2 };
  }

  if (arg2) {
    throw new Error(
      "Ambiguous arguments. Use 'ccm push <provider> <target>' or 'ccm push <target>'",
    );
  }

  return {
    providers: defaults,
    target: arg1,
  };
}

export function resolveBackupArguments(
  arg1: string | undefined,
  arg2: string | undefined,
  enabledProviders: ProviderName[],
): BackupResolution {
  const defaults = requireEnabledProviders(enabledProviders);

  if (!arg1) {
    if (arg2) {
      throw new Error("Unexpected second argument");
    }

    return { providers: defaults };
  }

  if (isProviderName(arg1)) {
    return { providers: [arg1], output: arg2 };
  }

  if (arg2) {
    throw new Error(
      "Ambiguous arguments. Use 'ccm backup <provider> <output>' or 'ccm backup <output>'",
    );
  }

  return {
    providers: defaults,
    output: arg1,
  };
}

export function resolveRestoreProvider(providerArg: string | undefined): ProviderName | undefined {
  if (!providerArg) {
    return undefined;
  }

  if (!isProviderName(providerArg)) {
    throw new Error(`Unknown provider '${providerArg}'. Valid providers: claude, codex`);
  }

  return providerArg;
}
