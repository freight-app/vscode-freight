import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

// Explorer tree data is intentionally local and lightweight. It only extracts
// enough freight.toml structure to populate the sidebar quickly.
interface ParsedManifest {
  package: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  buildDependencies: Record<string, string>;
  bins: Record<string, string>[];
  libs: Record<string, string>[];
  profiles: string[];
}

type ExplorerMeta = Record<string, any>;

const Kind = {
  ROOT_PROJECT: "root_project",
  ROOT_DEPS: "root_deps",
  ROOT_DEV_DEPS: "root_dev_deps",
  ROOT_BUILD_DEPS: "root_build_deps",
  ROOT_TARGETS: "root_targets",
  DEP: "dep",
  BIN_TARGET: "bin_target",
  LIB_TARGET: "lib_target",
  INFO: "info",
} as const;

class ExplorerNode extends vscode.TreeItem {
  kind: string;
  meta: ExplorerMeta;

  constructor(
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    kind: string,
    meta: ExplorerMeta = {}
  ) {
    super(label, collapsible);
    this.kind = kind;
    this.meta = meta;

    if (kind === Kind.DEP) {
      this.description = meta.version || "";
      this.contextValue = "freightDep";
      this.iconPath = new vscode.ThemeIcon("package");
      this.tooltip = `${label} ${meta.version || ""}`.trim();
      this.command = {
        command: "freight.openDepDoc",
        title: "Open Docs",
        arguments: [meta.name],
      };
    } else if (kind === Kind.BIN_TARGET) {
      this.iconPath = new vscode.ThemeIcon("run");
      this.description = meta.src || "";
      this.contextValue = "freightBinTarget";
      this.command = {
        command: "freight.debugTarget",
        title: "Debug",
        arguments: [meta.name],
      };
    } else if (kind === Kind.LIB_TARGET) {
      this.iconPath = new vscode.ThemeIcon("library");
      this.description = meta.src || "";
      this.contextValue = "freightLibTarget";
    } else if (kind === Kind.ROOT_PROJECT) {
      this.iconPath = new vscode.ThemeIcon("project");
      this.contextValue = "freightProject";
    } else if (kind === Kind.ROOT_DEPS) {
      this.iconPath = new vscode.ThemeIcon("references");
      this.contextValue = "freightDepGroup";
    } else if (kind === Kind.ROOT_DEV_DEPS) {
      this.iconPath = new vscode.ThemeIcon("beaker");
      this.contextValue = "freightDepGroup";
    } else if (kind === Kind.ROOT_BUILD_DEPS) {
      this.iconPath = new vscode.ThemeIcon("tools");
      this.contextValue = "freightDepGroup";
    } else if (kind === Kind.ROOT_TARGETS) {
      this.iconPath = new vscode.ThemeIcon("symbol-constructor");
      this.contextValue = "freightTargetGroup";
    } else if (kind === Kind.INFO) {
      this.iconPath = new vscode.ThemeIcon("info");
      this.contextValue = "freightInfo";
    }
  }
}

class FreightExplorerProvider implements vscode.TreeDataProvider<ExplorerNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ExplorerNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly onDidRefreshEmitter = new vscode.EventEmitter<void>();
  readonly onDidRefresh = this.onDidRefreshEmitter.event;

  private toml: ParsedManifest | null = null;
  private manifestPath: string | null = null;
  private watcher: vscode.FileSystemWatcher | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.setupWatcher();
  }

  dispose() {
    this.watcher?.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
    this.onDidRefreshEmitter.dispose();
  }

  refresh() {
    this.toml = null;
    this.manifestPath = null;

    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length) {
      const candidate = path.join(folders[0].uri.fsPath, "freight.toml");
      if (fs.existsSync(candidate)) {
        this.manifestPath = candidate;
        try {
          this.toml = parseFreightToml(fs.readFileSync(candidate, "utf8"));
        } catch {
          // Leave null; tree will show an error node.
        }
      }
    }

    this.onDidChangeTreeDataEmitter.fire(undefined);
    this.onDidRefreshEmitter.fire();
  }

  getTreeItem(element: ExplorerNode) {
    return element;
  }

  getChildren(element?: ExplorerNode) {
    if (!element) return this.rootNodes();
    return this.childNodes(element);
  }

  getBinNames() {
    return (this.toml?.bins ?? []).map((bin) => bin.name).filter(Boolean);
  }

  getProfiles() {
    const base = ["dev", "release"];
    const extra = (this.toml?.profiles ?? []).filter((profile) => !base.includes(profile));
    return [...base, ...extra];
  }

  private setupWatcher() {
    const pattern = new vscode.RelativePattern(
      vscode.workspace.workspaceFolders?.[0] || "",
      "freight.toml"
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidChange(() => this.refresh(), null, this.context.subscriptions);
    this.watcher.onDidCreate(() => this.refresh(), null, this.context.subscriptions);
    this.watcher.onDidDelete(() => this.refresh(), null, this.context.subscriptions);
    this.context.subscriptions.push(this.watcher);
    this.refresh();
  }

  private rootNodes() {
    if (!this.toml) {
      if (!this.manifestPath) {
        return [new ExplorerNode("No freight.toml found", vscode.TreeItemCollapsibleState.None, Kind.INFO)];
      }
      return [new ExplorerNode("Failed to parse freight.toml", vscode.TreeItemCollapsibleState.None, Kind.INFO)];
    }

    const manifest = this.toml;
    const nodes: ExplorerNode[] = [];
    const pkgName = manifest.package.name || "(unnamed)";
    const pkgVer = manifest.package.version ? `v${manifest.package.version}` : "";
    nodes.push(new ExplorerNode(
      pkgName + (pkgVer ? ` ${pkgVer}` : ""),
      vscode.TreeItemCollapsibleState.Expanded,
      Kind.ROOT_PROJECT,
      { pkg: manifest.package }
    ));

    if (Object.keys(manifest.dependencies).length > 0) {
      nodes.push(new ExplorerNode(
        `Dependencies (${Object.keys(manifest.dependencies).length})`,
        vscode.TreeItemCollapsibleState.Expanded,
        Kind.ROOT_DEPS,
        { deps: manifest.dependencies, section: "dependencies" }
      ));
    }

    if (Object.keys(manifest.buildDependencies).length > 0) {
      nodes.push(new ExplorerNode(
        `Build Dependencies (${Object.keys(manifest.buildDependencies).length})`,
        vscode.TreeItemCollapsibleState.Collapsed,
        Kind.ROOT_BUILD_DEPS,
        { deps: manifest.buildDependencies, section: "build-dependencies" }
      ));
    }

    if (Object.keys(manifest.devDependencies).length > 0) {
      nodes.push(new ExplorerNode(
        `Dev Dependencies (${Object.keys(manifest.devDependencies).length})`,
        vscode.TreeItemCollapsibleState.Collapsed,
        Kind.ROOT_DEV_DEPS,
        { deps: manifest.devDependencies, section: "dev-dependencies" }
      ));
    }

    const targetCount = manifest.bins.length + manifest.libs.length;
    if (targetCount > 0) {
      nodes.push(new ExplorerNode(
        `Targets (${targetCount})`,
        vscode.TreeItemCollapsibleState.Expanded,
        Kind.ROOT_TARGETS,
        { bins: manifest.bins, libs: manifest.libs }
      ));
    }

    return nodes;
  }

  private childNodes(element: ExplorerNode) {
    const { kind, meta } = element;

    if (kind === Kind.ROOT_PROJECT) {
      const pkg = meta.pkg;
      const items = [];
      if (pkg.language) items.push(infoNode(`Language: ${pkg.language}`));
      if (pkg.standard) items.push(infoNode(`Standard: ${pkg.standard}`));
      if (pkg.edition) items.push(infoNode(`Edition: ${pkg.edition}`));
      if (pkg.authors) items.push(infoNode(`Authors: ${pkg.authors}`));
      if (pkg.license) items.push(infoNode(`License: ${pkg.license}`));
      return items.length ? items : [infoNode("No package metadata")];
    }

    if (kind === Kind.ROOT_DEPS || kind === Kind.ROOT_DEV_DEPS || kind === Kind.ROOT_BUILD_DEPS) {
      return Object.entries(meta.deps).map(([name, version]) =>
        new ExplorerNode(name, vscode.TreeItemCollapsibleState.None, Kind.DEP, { name, version })
      );
    }

    if (kind === Kind.ROOT_TARGETS) {
      const nodes = [];
      for (const bin of meta.bins) {
        nodes.push(new ExplorerNode(
          bin.name || "(unnamed)",
          vscode.TreeItemCollapsibleState.None,
          Kind.BIN_TARGET,
          { name: bin.name || "", src: bin.src || "" }
        ));
      }
      for (const lib of meta.libs) {
        nodes.push(new ExplorerNode(
          lib.name || "(unnamed)",
          vscode.TreeItemCollapsibleState.None,
          Kind.LIB_TARGET,
          { name: lib.name || "", src: lib.src || "" }
        ));
      }
      return nodes;
    }

    return [];
  }
}

function parseFreightToml(src: string): ParsedManifest {
  // This is not a full TOML parser; it only tracks package metadata,
  // dependency tables, profiles, and [[bin]]/[[lib]] target headers.
  const lines = src.split(/\r?\n/);
  const result: ParsedManifest = {
    package: {},
    dependencies: {},
    devDependencies: {},
    buildDependencies: {},
    bins: [],
    libs: [],
    profiles: [],
  };

  let section: string | null = null;
  let currentTarget: Record<string, string> | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const arrayHeader = line.match(/^\[\[(\w[\w-]*)\]\]$/);
    if (arrayHeader) {
      const name = arrayHeader[1];
      currentTarget = {};
      if (name === "bin") result.bins.push(currentTarget);
      else if (name === "lib") result.libs.push(currentTarget);
      else currentTarget = null;
      section = null;
      continue;
    }

    const tableHeader = line.match(/^\[([^\]]+)\]$/);
    if (tableHeader) {
      currentTarget = null;
      section = tableHeader[1].trim();
      const profileMatch = section.match(/^profile\.(.+)$/);
      if (profileMatch) {
        const profile = profileMatch[1].trim();
        if (!result.profiles.includes(profile)) result.profiles.push(profile);
      }
      continue;
    }

    const kv = line.match(/^([\w-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    const val = unquote(rawVal.trim());

    if (currentTarget) {
      currentTarget[key] = val;
      continue;
    }

    if (section === "package") {
      result.package[key] = val;
    } else if (section === "dependencies") {
      result.dependencies[key] = depVersion(rawVal.trim());
    } else if (section === "dev-dependencies") {
      result.devDependencies[key] = depVersion(rawVal.trim());
    } else if (section === "build-dependencies") {
      result.buildDependencies[key] = depVersion(rawVal.trim());
    }
  }

  return result;
}

function unquote(value: string) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function depVersion(rawVal: string) {
  if (rawVal.startsWith('"') || rawVal.startsWith("'")) {
    return unquote(rawVal);
  }
  const version = rawVal.match(/version\s*=\s*["']([^"']+)["']/);
  if (version) return version[1];
  const pathDep = rawVal.match(/path\s*=\s*["']([^"']+)["']/);
  if (pathDep) return `path: ${pathDep[1]}`;
  const git = rawVal.match(/git\s*=\s*["']([^"']+)["']/);
  if (git) return "git";
  const url = rawVal.match(/url\s*=\s*["']([^"']+)["']/);
  if (url) return "url";
  const sys = rawVal.match(/system\s*=\s*["']([^"']+)["']/);
  if (sys) return `system: ${sys[1]}`;
  return "*";
}

function infoNode(label: string) {
  const node = new ExplorerNode(label, vscode.TreeItemCollapsibleState.None, Kind.INFO);
  node.iconPath = undefined;
  return node;
}

export { FreightExplorerProvider };
