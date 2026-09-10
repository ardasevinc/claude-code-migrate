import { displayText } from "./config-preview.ts";
import type { InventoryEntry } from "./inventory.ts";
import { deepFreeze, type MigrationPlan } from "./migration-plan.ts";

interface PreviewInput {
  readonly target: string;
  readonly before: readonly InventoryEntry[];
  readonly after: readonly InventoryEntry[];
  readonly settings?: readonly string[];
  readonly adaptations?: readonly string[];
  readonly effects?: readonly string[];
  readonly warnings?: readonly string[];
  readonly blockers?: readonly string[];
}

interface FileChange {
  readonly path: string;
  readonly action: "Add" | "Update" | "Remove";
}

interface Preview extends Omit<PreviewInput, "before" | "after"> {
  readonly files: readonly FileChange[];
  readonly unchanged: number;
}

// Human labels are private planning snapshots, never part of public plan JSON or its identity.
const previews = new WeakMap<object, Preview>();

export function registerMigrationPreview(
  planned: { readonly plan: MigrationPlan },
  input: PreviewInput,
): void {
  const before = new Map(input.before.map((entry) => [entry.path, entry]));
  const after = new Map(input.after.map((entry) => [entry.path, entry]));
  const files: FileChange[] = [];
  let unchanged = 0;
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const left = before.get(path),
      right = after.get(path);
    if (!left) files.push({ path, action: "Add" });
    else if (!right) files.push({ path, action: "Remove" });
    else if (
      left.sha256 !== right.sha256 ||
      left.mode !== right.mode ||
      left.type !== right.type ||
      left.size !== right.size
    )
      files.push({ path, action: "Update" });
    else unchanged++;
  }
  previews.set(
    planned,
    deepFreeze({
      target: input.target,
      files,
      unchanged,
      settings: [...(input.settings ?? [])],
      adaptations: [...(input.adaptations ?? [])],
      effects: [...(input.effects ?? [])],
      warnings: [...(input.warnings ?? [])],
      blockers: [...(input.blockers ?? [])],
    }),
  );
}

export function displayManagedPath(path: string): string {
  if (path === "claude/.mcp-config.json") return "~/.claude.json (MCP servers)";
  return displayText(
    path.replace(/^shared\/agents\//, "~/.agents/").replace(/^(claude|codex)\//, "~/.$1/"),
  );
}

function category(path: string): string {
  const parts = path.split("/");
  const scope = parts[0] === "shared" ? "Shared" : parts[0] === "claude" ? "Claude" : "Codex";
  const entry = parts[0] === "shared" ? parts[2] : parts[1];
  const names: Record<string, string> = {
    skills: "skills",
    "lazy-skills": "lazy skills",
    agents: "agents",
    rules: "rules",
    "AGENTS.md": "instructions",
    "AGENTS.override.md": "instruction overrides",
    "CLAUDE.md": "instructions",
    "config.toml": "settings",
    "settings.json": "settings",
    "settings.local.json": "local settings",
    "hooks.json": "hooks",
    hooks: "hooks",
    ".mcp-config.json": "MCP servers",
    ".skill-lock.json": "skill versions",
    ".ccm": "marketplace files",
    ".tmp": "marketplace files",
  };
  return `${scope} ${names[entry ?? ""] ?? displayText(entry ?? "files")}`;
}

function counts(files: readonly FileChange[]): string {
  return (["Add", "Update", "Remove"] as const)
    .flatMap((action) => {
      const count = files.filter((file) => file.action === action).length;
      return count
        ? [`${count} ${action === "Add" ? "new" : action === "Update" ? "updated" : "removed"}`]
        : [];
    })
    .join(", ");
}

export function renderMigrationPreview(
  planned: { readonly plan: MigrationPlan },
  options: { readonly verbose?: boolean } = {},
): string {
  const preview = previews.get(planned);
  if (!preview) throw new Error("Human preview is missing its planning snapshot");
  const { plan } = planned;
  const title =
    plan.kind === "push"
      ? "Push preview"
      : plan.kind === "restore"
        ? "Restore preview"
        : "Backup preview";
  const lines = [
    `${title}: ${plan.providers.map((name) => (name === "codex" ? "Codex" : "Claude")).join(" + ")} -> ${displayText(preview.target)}`,
  ];
  if (plan.profile) lines.push(`Profile: ${displayText(plan.profile)}`);
  if (plan.status === "blocked")
    lines.push("Blocked: this migration cannot run yet. Proposed changes below are not applied.");
  else if (plan.status === "noop") lines.push("Already up to date. No changes needed.");
  else if (plan.kind === "backup")
    lines.push(`Would write an archive containing ${preview.files.length} files.`);
  else
    lines.push(
      `Would change ${preview.files.length} files (${counts(preview.files) || "no file changes"})${preview.effects?.length ? ` and install ${preview.effects.length} plugin${preview.effects.length === 1 ? "" : "s"}` : ""}.`,
    );

  function section(title: string, items: readonly string[] | undefined, limit = 12): void {
    if (!items?.length) return;
    lines.push("", `${title}:`);
    const shown = options.verbose ? items : items.slice(0, limit);
    lines.push(...shown.map((item) => `  ${item}`));
    if (shown.length < items.length)
      lines.push(`  ... ${items.length - shown.length} more; use --verbose to see all.`);
  }
  section("Needs attention", preview.blockers, Number.POSITIVE_INFINITY);
  const projectChanges = (preview.settings ?? []).filter((line) =>
    /^(Add|Update|Remove) project permissions /.test(line),
  );
  const projectSet = new Set(projectChanges);
  const settings =
    !options.verbose && projectChanges.length
      ? [
          ...(preview.settings ?? []).filter((line) => !projectSet.has(line)),
          `Project permissions: ${["Add", "Update", "Remove"]
            .flatMap((action) => {
              const count = projectChanges.filter((line) => line.startsWith(action)).length;
              return count
                ? [
                    `${count} ${action === "Add" ? "added" : action === "Update" ? "updated" : "removed"}`,
                  ]
                : [];
            })
            .join(", ")} (paths in --verbose)`,
        ]
      : preview.settings;
  section("Settings on the target", settings, 24);
  const groups = new Map<string, FileChange[]>();
  for (const file of preview.files) {
    const label = category(file.path);
    const group = groups.get(label);
    if (group) group.push(file);
    else groups.set(label, [file]);
  }
  section(
    plan.kind === "backup" ? "Archive contents" : "Files",
    [...groups].map(([label, files]) => {
      const names = [
        ...new Set(
          files.map(({ path }) => {
            const parts = path.split("/");
            return displayText(
              parts[1] === ".ccm" && parts[2] === "marketplaces"
                ? (parts[3] ?? path)
                : parts[1] === ".tmp"
                  ? "openai-curated"
                  : parts[0] === "shared"
                    ? (parts[3] ?? parts[2] ?? path)
                    : (parts[2] ?? parts[1] ?? path),
            );
          }),
        ),
      ];
      const listed = names.slice(0, 5).join(", ");
      return `${label}: ${plan.kind === "backup" ? `${files.length} files` : counts(files)} (${listed}${names.length > 5 ? `, +${names.length - 5} more` : ""})`;
    }),
    Number.POSITIVE_INFINITY,
  );
  if (options.verbose)
    section(
      "File details",
      preview.files.map((file) => `${file.action} ${displayManagedPath(file.path)}`),
    );
  section("Plugins to install", preview.effects, 40);
  section("Adaptations from the source", preview.adaptations, 40);
  section("Warnings", preview.warnings);
  lines.push("", `Dry run only. ${preview.unchanged} observed files unchanged. Nothing written.`);
  if (plan.kind !== "backup" && plan.status !== "noop")
    lines.push("Target-only files are kept unless listed for replacement or removal above.");
  lines.push("Use --verbose for all details; --json for the machine-readable plan.");
  return lines.join("\n");
}
