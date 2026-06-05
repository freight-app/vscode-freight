import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { cppTerminateMessage, runFreightCommand, runFreightTaskAndWait } from "./execution";
import { getActiveWorkspaceFolder, resolveCwd } from "./utils";
import type { ExtensionState } from "./state";

// Handles VS Code Run/Debug integration. "Run" is intentionally routed through
// Freight tasks, while "Debug" starts freight dap and the native debugger DAP.
interface FreightDebugConfig extends vscode.DebugConfiguration {
  mode?: "run" | "debug";
  profile?: string;
  release?: boolean;
  package?: string;
  bin?: string;
  features?: string[];
  noDefaultFeatures?: boolean;
  debugger?: string;
  debuggerPath?: string;
  debuggerArgs?: string[];
  buildBeforeDebug?: boolean;
  noBuild?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  args?: string[];
  stopAtEntry?: boolean;
  stopAtBeginningOfMainSubprogram?: boolean;
  sysroot?: string;
  family?: string;
}

function registerDebug(context: import("vscode").ExtensionContext, state: ExtensionState) {
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider("freight", new FreightDebugProvider(state)),
    vscode.debug.registerDebugAdapterDescriptorFactory("freight", new FreightDebugAdapterFactory(state)),
    vscode.debug.registerDebugAdapterTrackerFactory("freight", new FreightDebugTrackerFactory())
  );
}

class FreightDebugProvider {
  state: ExtensionState;

  constructor(state: ExtensionState) {
    this.state = state;
  }

  resolveDebugConfiguration(folder: import("vscode").WorkspaceFolder | undefined, config: FreightDebugConfig) {
    const workspaceFolder = folder || getActiveWorkspaceFolder();
    if (!workspaceFolder) {
      vscode.window.showWarningMessage("Open a Freight workspace before launching a Freight debug configuration.");
      return undefined;
    }
    const mode = config.mode || "run";
    const release = config.release ?? this.state.activeProfile === "release";
    return {
      ...config,
      type: "freight",
      request: config.request || "launch",
      name: config.name || (mode === "debug" ? "Freight: Debug" : "Freight: Run"),
      mode,
      profile: config.profile ?? (release ? "release" : this.state.activeProfile),
      release,
      bin: config.bin ?? this.state.activeTarget ?? undefined,
      sysroot: config.sysroot ?? this.state.activeSysroot ?? undefined,
      family: config.family ?? this.state.activeFamily ?? undefined,
      cwd: resolveCwd(config.cwd, workspaceFolder),
      args: Array.isArray(config.args) ? config.args : [],
      stopAtBeginningOfMainSubprogram: config.stopAtBeginningOfMainSubprogram ?? config.stopAtEntry ?? undefined,
    };
  }

  async provideDebugConfigurations(): Promise<vscode.DebugConfiguration[]> {
    const bins: string[] = this.state.explorerProvider?.getBinNames() ?? [];
    const configs: FreightDebugConfig[] = [
      { name: "Freight: Run", type: "freight", request: "launch", mode: "run", cwd: "${workspaceFolder}", args: [] },
      { name: "Freight: Debug", type: "freight", request: "launch", mode: "debug", cwd: "${workspaceFolder}", args: [] },
    ];
    for (const bin of bins) {
      configs.push({
        name: `Freight: Debug ${bin}`,
        type: "freight",
        request: "launch",
        mode: "debug",
        bin,
        cwd: "${workspaceFolder}",
        args: [],
      });
    }
    return configs;
  }
}

class FreightDebugAdapterFactory {
  state: ExtensionState;

  constructor(state: ExtensionState) {
    this.state = state;
  }

  async createDebugAdapterDescriptor(session: import("vscode").DebugSession) {
    const config = session.configuration as FreightDebugConfig;
    const freight = vscode.workspace.getConfiguration("freight").get<string>("executablePath", "freight");
    const folder = getActiveWorkspaceFolder();
    const cwd = folder ? resolveCwd(config.cwd, folder) : undefined;

    // Run mode is exposed through VS Code's Run menu, but the actual command is
    // a normal terminal task so users can see the program output directly.
    if (config.mode === "run") {
      if (folder) {
        const resolvedConfig = await resolveBin(config, this.state);
        if (!resolvedConfig) {
          return new vscode.DebugAdapterInlineImplementation(new CancelledAdapter());
        }
        await runFreightCommand(buildRunArgs(resolvedConfig));
      }
      return new vscode.DebugAdapterInlineImplementation(new CancelledAdapter());
    }

    let resolvedConfig = await resolveBin(config, this.state);
    if (!resolvedConfig) {
      return new vscode.DebugAdapterInlineImplementation(new CancelledAdapter());
    }

    // Follow cpptools' task-first model: build in the integrated terminal, then
    // ask freight dap to reuse the already-built binary instead of rebuilding
    // silently inside the adapter process.
    if (shouldBuildBeforeDebug(resolvedConfig)) {
      const exitCode = await runFreightTaskAndWait(buildDebugBuildArgs(resolvedConfig));
      if (exitCode !== 0) {
        vscode.window.showErrorMessage(`freight build failed with exit code ${exitCode ?? "unknown"}.`);
        return new vscode.DebugAdapterInlineImplementation(new CancelledAdapter());
      }
      resolvedConfig = { ...resolvedConfig, noBuild: true };
    }

    const dapArgs = ["dap"];
    if (resolvedConfig.request === "attach") dapArgs.push("--attach");
    const configPath = writeDapConfig(resolvedConfig);
    if (configPath) dapArgs.push("--config", configPath);

    return new vscode.DebugAdapterExecutable(freight, dapArgs, cwd ? { cwd } : undefined);
  }
}

class FreightDebugTrackerFactory {
  createDebugAdapterTracker(session: import("vscode").DebugSession) {
    return new FreightDebugTracker(session);
  }
}

class FreightDebugTracker {
  session: import("vscode").DebugSession;
  output = "";
  notified = false;

  constructor(session: import("vscode").DebugSession) {
    this.session = session;
  }

  // Debug mode receives program stdout/stderr as DAP output events from the
  // native adapter. Watch those events for C++ terminate/what() runtime output.
  onDidSendMessage(message: any) {
    if (message?.type !== "event" || message.event !== "output") return;
    const output = message.body && typeof message.body.output === "string"
      ? message.body.output
      : "";
    if (!output) return;
    this.output += output;
    this.maybeNotify();
  }

  onExit() {
    this.maybeNotify();
  }

  maybeNotify() {
    if (this.notified) return;
    const popup = debugRuntimePopupMessage(this.session.configuration, this.output);
    if (!popup) return;
    this.notified = true;
    vscode.window.showErrorMessage(popup);
  }
}

function debugRuntimePopupMessage(config: FreightDebugConfig | undefined, output: string): string | null {
  const mode = config?.mode || "debug";
  if (mode !== "debug") return null;
  return cppTerminateMessage(output);
}

class CancelledAdapter {
  private readonly messageEmitter = new vscode.EventEmitter<any>();
  private _cb?: (message: any) => void;
  readonly onDidSendMessage = this.messageEmitter.event;

  // Used for "Freight: Run": VS Code expects a debug adapter, but the work was
  // delegated to a task, so this adapter immediately ends the debug session.
  onError() {}
  onExit() {}

  handleMessage(message: any) {
    if (message.command === "initialize") {
      this._sendEvent("initialized");
      this._sendResponse(message, {});
    } else if (message.command === "launch" || message.command === "attach") {
      this._sendResponse(message, {});
      this._sendEvent("terminated");
    } else {
      this._sendResponse(message, {});
    }
  }

  _sendResponse(req: any, body: Record<string, unknown>) {
    this._emit({
      type: "response",
      request_seq: req.seq,
      seq: 0,
      success: true,
      command: req.command,
      body,
    });
  }

  _sendEvent(event: string) {
    this._emit({ type: "event", seq: 0, event });
  }

  _emit(message: any) {
    this.messageEmitter.fire(message);
    if (this._cb) this._cb(message);
  }

  sendMessage() {}
  dispose() { this.messageEmitter.dispose(); }
  setMessageCallback(cb: (message: any) => void) { this._cb = cb; }
}

async function resolveBin(config: FreightDebugConfig, state: ExtensionState): Promise<FreightDebugConfig | null> {
  if (config.bin || config.request === "attach") return config;
  const bins: string[] = state.explorerProvider?.getBinNames() ?? [];
  if (bins.length <= 1) return config;
  const choice = await vscode.window.showQuickPick<{ label: string }>(
    bins.map((bin) => ({ label: bin })),
    { placeHolder: "Select binary to run" }
  );
  if (!choice) return null;
  return { ...config, bin: choice.label };
}

function buildRunArgs(config: FreightDebugConfig) {
  const args = ["run"];
  if (config.release) args.push("--release");
  if (config.package) args.push("-p", config.package);
  if (config.bin) args.push("--bin", config.bin);
  if (Array.isArray(config.features) && config.features.length > 0) {
    args.push("--features", config.features.join(","));
  }
  if (config.noDefaultFeatures) args.push("--no-default-features");
  if (Array.isArray(config.args) && config.args.length > 0) {
    args.push("--", ...config.args);
  }
  return args;
}

function shouldBuildBeforeDebug(config: FreightDebugConfig) {
  return config.request !== "attach"
    && config.mode !== "run"
    && config.noBuild !== true
    && config.buildBeforeDebug !== false
    && canBuildProfileWithTask(config);
}

function buildDebugBuildArgs(config: FreightDebugConfig) {
  const args = ["build"];
  if (config.release || config.profile === "release") args.push("--release");
  if (config.package) args.push("-p", config.package);
  if (Array.isArray(config.features) && config.features.length > 0) {
    args.push("--features", config.features.join(","));
  }
  if (config.noDefaultFeatures) args.push("--no-default-features");
  return args;
}

function canBuildProfileWithTask(config: FreightDebugConfig) {
  // `freight build` currently exposes dev by default and release through
  // `--release`; custom profiles still need freight dap's internal build path.
  const profile = config.profile || (config.release ? "release" : "dev");
  return profile === "dev" || profile === "release";
}

function writeDapConfig(config: FreightDebugConfig) {
  const payload = dapConfigPayload(config);
  const file = path.join(
    os.tmpdir(),
    `freight-dap-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  fs.writeFileSync(file, JSON.stringify(payload));
  setTimeout(() => fs.unlink(file, () => {}), 60_000).unref?.();
  return file;
}

function dapConfigPayload(config: FreightDebugConfig) {
  const payload: Record<string, unknown> = {
    request: config.request,
    profile: config.profile,
    release: config.release,
    package: config.package,
    bin: config.bin,
    features: Array.isArray(config.features) ? config.features : undefined,
    noDefaultFeatures: config.noDefaultFeatures,
    noBuild: config.noBuild,
    debugger: config.debugger,
    debuggerPath: config.debuggerPath,
    debuggerArgs: Array.isArray(config.debuggerArgs) ? config.debuggerArgs : undefined,
    cwd: config.cwd,
    env: config.env,
    args: Array.isArray(config.args) ? config.args : undefined,
    stopAtEntry: config.stopAtEntry,
    stopAtBeginningOfMainSubprogram: config.stopAtBeginningOfMainSubprogram ?? config.stopAtEntry,
  };
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) delete payload[key];
  }
  return payload;
}

export {
  FreightDebugAdapterFactory,
  FreightDebugProvider,
  FreightDebugTrackerFactory,
  buildRunArgs,
  dapConfigPayload,
  debugRuntimePopupMessage,
  registerDebug,
};
