import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { freightDocumentSelector } from "./utils";
import type { ExtensionState } from "./state";
import type { StatusController } from "./status";

const FREIGHT_LSP_PID_FILE = "/tmp/freight-lsp-debug.pid";

let client: InstanceType<typeof LanguageClient> | undefined;

// Expand a leading `~` so users can write ~/bin/freight in settings.
function resolveExePath(exe: string): string {
  if (exe === "~" || exe.startsWith("~/") || exe.startsWith("~" + path.sep)) {
    return path.join(os.homedir(), exe.slice(1));
  }
  return exe;
}

// VS Code is often launched from a desktop launcher whose PATH is the bare
// system PATH, missing ~/.cargo/bin and other user-local prefix dirs where
// `freight` (and fortls/asm-lsp) typically live.
function buildEnv(extra: Record<string, string> = {}): Record<string, string> {
  const home = os.homedir();
  const extraDirs = [
    path.join(home, ".cargo", "bin"),
    path.join(home, ".local", "bin"),
    "/usr/local/bin",
  ];
  const sep = path.delimiter;
  const existing = (process.env.PATH || "").split(sep).filter(Boolean);
  const merged = [
    ...extraDirs.filter(d => !existing.includes(d)),
    ...existing,
  ].join(sep);
  return { ...(process.env as Record<string, string>), PATH: merged, ...extra };
}

// Search for a bare command name in the augmented PATH by checking each dir
// with fs.existsSync — necessary because Node's spawn PATH resolution uses
// the child process environment, not the parent's, so we can't rely on it
// to find binaries added via buildEnv.
function findInPath(cmd: string, augmentedPath: string): string | undefined {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : undefined;
  for (const dir of augmentedPath.split(path.delimiter)) {
    const candidate = path.join(dir, cmd);
    if (fs.existsSync(candidate)) return candidate;
    // On Windows try .exe; harmless on Linux.
    if (fs.existsSync(candidate + ".exe")) return candidate + ".exe";
  }
  return undefined;
}

// Collect candidate root directories to look for dev-built freight binaries.
// Tries (in order):
//   - VS Code workspace folders
//   - Extension directory walked upward (handles dev mode where extension
//     lives inside the freight-workspace repo tree)
function collectSearchRoots(extensionPath: string): string[] {
  const roots: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    roots.push(folder.uri.fsPath);
  }
  // Walk up from the extension directory: editors/vscode-freight is two
  // levels inside the workspace root in a typical freight checkout.
  let dir = extensionPath;
  for (let i = 0; i < 4; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (!roots.includes(dir)) roots.push(dir);
  }
  return roots;
}

// Resolve the freight binary.  Priority:
//   1. Configured executablePath if it's an absolute / ~-expanded path
//   2. Augmented PATH search for a bare name
//   3. target/debug/<name> inside each workspace / ancestor directory
//   4. target/release/<name> inside each workspace / ancestor directory
// Returns the resolved path, or the original string if nothing is found so
// the spawn attempt can still fail with a meaningful ENOENT message.
function resolveFreightBinary(configured: string, extensionPath: string): string {
  const expanded = resolveExePath(configured);

  // Absolute path: use as-is.
  if (path.isAbsolute(expanded)) return expanded;

  // Bare name: search augmented PATH.
  const env = buildEnv();
  const found = findInPath(expanded, env.PATH);
  if (found) return found;

  // Fallback: look for a local dev build in workspace / ancestor dirs.
  for (const root of collectSearchRoots(extensionPath)) {
    for (const profile of ["debug", "release"]) {
      const candidate = path.join(root, "target", profile, expanded);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // Nothing found — return the bare name so spawn produces a clear ENOENT.
  return expanded;
}


async function startLanguageServer(
  context: import("vscode").ExtensionContext,
  state: ExtensionState,
  status: StatusController
) {
  const config = vscode.workspace.getConfiguration("freight");
  if (!config.get("lsp.enabled", true)) {
    status.refresh("idle");
    return;
  }

  const freight = resolveFreightBinary(config.get("executablePath", "freight") as string, context.extensionPath);
  const profile = config.get("lsp.profile", "dev") as string;
  const fortls = resolveExePath(config.get("lsp.fortlsPath", "fortls") as string);
  const asmLsp = resolveExePath(config.get("lsp.asmLspPath", "asm-lsp") as string);
  const enableFortls = config.get("lsp.enableFortls", true) as boolean;
  const enableAsmLsp = config.get("lsp.enableAsmLsp", true) as boolean;
  const logLevel = config.get("lsp.logLevel", "") as string;

  const args = ["lsp", "--profile", profile, "--fortls", fortls, "--asm-lsp", asmLsp];
  if (!enableFortls) args.push("--no-fortls");
  if (!enableAsmLsp) args.push("--no-asm-lsp");

  const extraEnv = logLevel ? { FREIGHT_LOG: logLevel } : {};
  const env = buildEnv(extraEnv);
  const serverOptions = { command: freight, args, options: { env } };

  client = new LanguageClient(
    "freight",
    "Freight Language Server",
    serverOptions,
    {
      documentSelector: freightDocumentSelector(),
      synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher("**/freight.toml") },
      outputChannelName: "Freight Language Server",
    }
  );

  context.subscriptions.push(client);
  status.refresh("building");
  try {
    await client.start();
    status.refresh("ok");
  } catch (error) {
    status.refresh("fail");
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showWarningMessage(
      `Could not start freight lsp (tried: ${freight}): ${message}`,
      "Set freight path"
    ).then(choice => {
      if (choice === "Set freight path") {
        vscode.commands.executeCommand("workbench.action.openSettings", "freight.executablePath");
      }
    });
  }
}

async function stopLanguageServer(_state: ExtensionState, status: StatusController) {
  if (!client) return;
  const old = client;
  client = undefined;
  try {
    await old.stop();
  } catch {
    // Client may already be stopped or failed to start.
  }
  status.refresh("idle");
}

function getClient() {
  return client;
}


async function attachFreightDebugger() {
  // Development-only helper: attach CodeLLDB to the Rust freight lsp process.
  let pid;
  try {
    const content = fs.readFileSync(FREIGHT_LSP_PID_FILE, "utf8").trim();
    const n = parseInt(content, 10);
    if (n > 0) pid = n;
  } catch {
    // Server is probably running without debug PID handoff.
  }

  if (!pid) pid = findFreightLspPid();

  if (!pid) {
    vscode.window.showWarningMessage(
      "Could not find a running freight lsp process. Start the extension host first (F5)."
    );
    return;
  }

  const folder = (vscode.workspace.workspaceFolders || [])[0];
  await vscode.debug.startDebugging(folder, {
    type: "lldb",
    request: "attach",
    name: "Attach to freight LSP (Rust)",
    pid,
    stopOnEntry: false,
    sourceLanguages: ["rust"],
  });
}

function findFreightLspPid(): number | null {
  try {
    const entries = fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry));
    for (const entry of entries) {
      try {
        const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
        const parts = cmdline.split("\0").filter(Boolean);
        const exe = parts[0] || "";
        const isFreight = exe === "freight"
          || exe.endsWith("/freight")
          || exe.endsWith("/debug/freight");
        if (isFreight && parts.includes("lsp")) {
          return parseInt(entry, 10);
        }
      } catch {
        // Process ended or is not readable.
      }
    }
  } catch {
    // Non-Linux or /proc not available.
  }
  return null;
}

export {
  attachFreightDebugger,
  getClient,
  startLanguageServer,
  stopLanguageServer,
};
