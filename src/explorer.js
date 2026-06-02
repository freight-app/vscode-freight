const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

// ── Minimal TOML extractor (no external deps) ──────────────────────────────

/**
 * Extract the first [package] section key values and all dependency sections
 * from a freight.toml string. We don't need a full TOML parser — just
 * enough to populate the explorer tree.
 */
function parseFreightToml(src) {
  const lines = src.split(/\r?\n/);

  const result = {
    package: {},
    dependencies: {},
    devDependencies: {},
    buildDependencies: {},
    bins: [],
    libs: [],
  };

  let section = null; // current section name
  let currentTarget = null; // current [[bin]] or [[lib]] object

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    // Section headers
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
      continue;
    }

    // Key = value
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

function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function depVersion(rawVal) {
  // Simple string version: "1.2" or '*'
  if (rawVal.startsWith('"') || rawVal.startsWith("'")) {
    return unquote(rawVal);
  }
  // Inline table: { version = "1.2", ... }
  const m = rawVal.match(/version\s*=\s*["']([^"']+)["']/);
  if (m) return m[1];
  const path = rawVal.match(/path\s*=\s*["']([^"']+)["']/);
  if (path) return `path: ${path[1]}`;
  const git = rawVal.match(/git\s*=\s*["']([^"']+)["']/);
  if (git) return "git";
  const url = rawVal.match(/url\s*=\s*["']([^"']+)["']/);
  if (url) return "url";
  const sys = rawVal.match(/system\s*=\s*["']([^"']+)["']/);
  if (sys) return `system: ${sys[1]}`;
  return "*";
}

// ── Tree node kinds ────────────────────────────────────────────────────────

const Kind = {
  ROOT_PROJECT: "root_project",
  ROOT_DEPS: "root_deps",
  ROOT_DEV_DEPS: "root_dev_deps",
  ROOT_BUILD_DEPS: "root_build_deps",
  ROOT_TARGETS: "root_targets",
  DEP: "dep",
  TARGET: "target",
  INFO: "info",
};

class ExplorerNode extends vscode.TreeItem {
  constructor(label, collapsible, kind, meta = {}) {
    super(label, collapsible);
    this.kind = kind;
    this.meta = meta; // { name, version, section, targetType }

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
    } else if (kind === Kind.TARGET) {
      this.iconPath = new vscode.ThemeIcon(meta.targetType === "bin" ? "run" : "library");
      this.description = meta.src || "";
      this.contextValue = "freightTarget";
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

// ── Provider ───────────────────────────────────────────────────────────────

class FreightExplorerProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._toml = null;
    this._manifestPath = null;
    this._watcher = null;
    this._setupWatcher();
  }

  _setupWatcher() {
    const pattern = new vscode.RelativePattern(
      vscode.workspace.workspaceFolders?.[0] || "",
      "freight.toml"
    );
    this._watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this._watcher.onDidChange(() => this.refresh());
    this._watcher.onDidCreate(() => this.refresh());
    this._watcher.onDidDelete(() => this.refresh());
    this.refresh();
  }

  refresh() {
    this._toml = null;
    this._manifestPath = null;

    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length) {
      const candidate = path.join(folders[0].uri.fsPath, "freight.toml");
      if (fs.existsSync(candidate)) {
        this._manifestPath = candidate;
        try {
          this._toml = parseFreightToml(fs.readFileSync(candidate, "utf8"));
        } catch {
          // leave null — tree will show error node
        }
      }
    }

    this._onDidChangeTreeData.fire(undefined);
  }

  dispose() {
    this._watcher?.dispose();
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (!element) return this._rootNodes();
    return this._childNodes(element);
  }

  _rootNodes() {
    if (!this._toml) {
      if (!this._manifestPath) {
        return [new ExplorerNode("No freight.toml found", vscode.TreeItemCollapsibleState.None, Kind.INFO)];
      }
      return [new ExplorerNode("Failed to parse freight.toml", vscode.TreeItemCollapsibleState.None, Kind.INFO)];
    }

    const t = this._toml;
    const nodes = [];

    // Project node
    const pkgName = t.package.name || "(unnamed)";
    const pkgVer = t.package.version ? `v${t.package.version}` : "";
    const projectNode = new ExplorerNode(
      pkgName + (pkgVer ? ` ${pkgVer}` : ""),
      vscode.TreeItemCollapsibleState.Expanded,
      Kind.ROOT_PROJECT,
      { pkg: t.package }
    );
    nodes.push(projectNode);

    // Dependencies
    if (Object.keys(t.dependencies).length > 0) {
      nodes.push(new ExplorerNode(
        `Dependencies (${Object.keys(t.dependencies).length})`,
        vscode.TreeItemCollapsibleState.Expanded,
        Kind.ROOT_DEPS,
        { deps: t.dependencies, section: "dependencies" }
      ));
    }

    if (Object.keys(t.buildDependencies).length > 0) {
      nodes.push(new ExplorerNode(
        `Build Dependencies (${Object.keys(t.buildDependencies).length})`,
        vscode.TreeItemCollapsibleState.Collapsed,
        Kind.ROOT_BUILD_DEPS,
        { deps: t.buildDependencies, section: "build-dependencies" }
      ));
    }

    if (Object.keys(t.devDependencies).length > 0) {
      nodes.push(new ExplorerNode(
        `Dev Dependencies (${Object.keys(t.devDependencies).length})`,
        vscode.TreeItemCollapsibleState.Collapsed,
        Kind.ROOT_DEV_DEPS,
        { deps: t.devDependencies, section: "dev-dependencies" }
      ));
    }

    // Targets
    const targetCount = t.bins.length + t.libs.length;
    if (targetCount > 0) {
      nodes.push(new ExplorerNode(
        `Targets (${targetCount})`,
        vscode.TreeItemCollapsibleState.Expanded,
        Kind.ROOT_TARGETS,
        { bins: t.bins, libs: t.libs }
      ));
    }

    return nodes;
  }

  _childNodes(element) {
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
          Kind.TARGET,
          { targetType: "bin", src: bin.src || "" }
        ));
      }
      for (const lib of meta.libs) {
        nodes.push(new ExplorerNode(
          lib.name || "(unnamed)",
          vscode.TreeItemCollapsibleState.None,
          Kind.TARGET,
          { targetType: "lib", src: lib.src || "" }
        ));
      }
      return nodes;
    }

    return [];
  }
}

function infoNode(label) {
  const node = new ExplorerNode(label, vscode.TreeItemCollapsibleState.None, Kind.INFO);
  node.iconPath = undefined;
  return node;
}

module.exports = { FreightExplorerProvider };
