import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";
import * as fs from "fs";
import * as path from "path";

import {
  appendIfChanged,
  freightDocumentSelector,
} from "./utils";
import type { ExtensionState } from "./state";
import type { StatusController } from "./status";

// Starts and owns the freight lsp process. Source-language servers such as
// clangd are configured by freight lsp itself, not directly by the extension.
const FREIGHT_LSP_PID_FILE = "/tmp/freight-lsp-debug.pid";

let client: InstanceType<typeof LanguageClient> | undefined;

interface WorkspaceInfoResponse {
  toolchains?: Array<{ family: string }>;
  sysroot?: string;
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

  const freight = config.get("executablePath", "freight");
  const args = ["lsp"];

  appendIfChanged(args, "--profile", config.get("lsp.profile", "dev"), "dev");
  appendIfChanged(args, "--clangd", config.get("lsp.clangdPath", "clangd"), "clangd");
  appendIfChanged(args, "--fortls", config.get("lsp.fortlsPath", "fortls"), "fortls");
  appendIfChanged(args, "--asm-lsp", config.get("lsp.asmLspPath", "asm-lsp"), "asm-lsp");

  if (!config.get("lsp.enableClangd", true)) args.push("--no-clangd");
  if (!config.get("lsp.enableFortls", true)) args.push("--no-fortls");
  if (!config.get("lsp.enableAsmLsp", true)) args.push("--no-asm-lsp");

  const isDev = context.extensionMode === vscode.ExtensionMode.Development;
  const cfgLogLevel = config.get("lsp.logLevel", "");
  const logLevel = cfgLogLevel || (isDev ? "debug" : "");
  const serverEnv = logLevel ? { ...process.env, FREIGHT_LOG: logLevel } : undefined;

  const extensionRoot = path.resolve(__dirname, "..");
  const cargoWorkspace = path.resolve(extensionRoot, "../..");
  const serverOptions = isDev
    ? {
        command: "cargo",
        args: ["run", "-p", "freight", "--", ...args],
        options: { cwd: cargoWorkspace, env: serverEnv },
      }
    : { command: freight, args, options: { env: serverEnv } };

  client = new LanguageClient(
    "freight",
    "Freight",
    serverOptions,
    {
      documentSelector: freightDocumentSelector(),
      synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher("**/freight.toml") },
      outputChannelName: "Freight Language Server",
    }
  );

  client.onNotification("freight/docIndexUpdated", (params) => {
    const count = params && typeof params.items === "number" ? params.items : 0;
    status.setDocIndexCount(count);
  });

  context.subscriptions.push(client);
  status.refresh("building");
  try {
    await client.start();
    status.refresh("ok");
    queryWorkspaceInfo(context, state, status).catch(() => {});
  } catch (error) {
    status.refresh("fail");
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showWarningMessage(`Could not start freight lsp: ${message}`);
  }
}

async function stopLanguageServer(state: ExtensionState, status: StatusController) {
  if (!client) return;
  const old = client;
  client = undefined;
  await old.stop();
  state.detectedFamilies = null;
  status.docIndexCount = 0;
  status.renderDocIndex();
  status.refresh("idle");
}

function getClient() {
  return client;
}

async function queryWorkspaceInfo(
  context: import("vscode").ExtensionContext,
  state: ExtensionState,
  status: StatusController
) {
  // Workspace info seeds UI state from freight.toml/toolchain detection without
  // writing user settings unless the user has not picked a value locally yet.
  if (!client) return;
  const info = await client.sendRequest<WorkspaceInfoResponse>("freight/workspaceInfo");
  if (!info) return;

  if (Array.isArray(info.toolchains)) {
    state.detectedFamilies = ["auto", ...info.toolchains.map((tc) => tc.family)];
  }

  const savedSysroot = context.workspaceState.get("freight.sysroot", null);
  if (savedSysroot === null && info.sysroot) {
    state.activeSysroot = info.sysroot;
    await context.workspaceState.update("freight.sysroot", state.activeSysroot);
    status.refresh("idle");
  }
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
