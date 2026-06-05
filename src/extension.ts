import * as vscode from "vscode";

import * as configuration from "./configuration";
import * as debug from "./debug";
import * as execution from "./execution";
import * as lsp from "./lsp";
import { FreightExplorerProvider } from "./explorer";
import { createState } from "./state";
import { createStatusController, registerTaskStatusTracking } from "./status";
import { getActiveWorkspaceFolder } from "./utils";
import type { ExtensionState } from "./state";
import type { StatusController } from "./status";

// The extension entrypoint only wires feature modules together. Behavior lives
// in lsp/debug/execution/configuration so each VS Code surface stays readable.
interface ExtensionRuntime {
  state: ExtensionState;
  status: StatusController;
}

let runtime: ExtensionRuntime | null = null;

function activate(context: import("vscode").ExtensionContext) {
  try {
    _activate(context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`freight extension failed to activate: ${message}`);
    throw err;
  }
}

function _activate(context: import("vscode").ExtensionContext) {
  const state = createState(context);
  const status = createStatusController(context, state);
  runtime = { state, status };

  registerTaskStatusTracking(context, status);
  execution.registerFreightTaskProvider(context);
  debug.registerDebug(context, state);

  state.explorerProvider = new FreightExplorerProvider(context);
  const explorerView = vscode.window.createTreeView("freight.explorerView", {
    treeDataProvider: state.explorerProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(explorerView);
  state.explorerProvider.onDidRefresh(() => status.refresh("idle"));

  registerCoreCommands(context, state, status);
  configuration.registerConfigurationCommands(context, state, status, lsp);
  configuration.registerConfigurationWatcher(context, state, status, lsp);

  lsp.startLanguageServer(context, state, status);
}

// Core commands either dispatch into a feature module or launch a VS Code debug
// session; configuration/status commands are registered in configuration.ts.
function registerCoreCommands(
  context: import("vscode").ExtensionContext,
  state: ExtensionState,
  status: StatusController
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("freight.restartLanguageServer", async () => {
      await lsp.stopLanguageServer(state, status);
      await lsp.startLanguageServer(context, state, status);
    }),
    vscode.commands.registerCommand("freight.generateCompileCommands", async () => {
      await execution.runFreightCommand(["compile-commands"]);
    }),
    vscode.commands.registerCommand("freight.run", async () => {
      await vscode.debug.startDebugging(getActiveWorkspaceFolder(), {
        type: "freight",
        request: "launch",
        name: "Freight: Run",
        mode: "run",
        release: state.activeProfile === "release",
        cwd: "${workspaceFolder}",
        args: [],
      });
    }),
    vscode.commands.registerCommand("freight.debug", async () => {
      await vscode.debug.startDebugging(getActiveWorkspaceFolder(), {
        type: "freight",
        request: "launch",
        name: "Freight: Debug",
        mode: "debug",
        cwd: "${workspaceFolder}",
        args: [],
      });
    }),
    vscode.commands.registerCommand("freight.refreshExplorer", () => {
      state.explorerProvider.refresh();
    }),
    vscode.commands.registerCommand("freight.attachRustDebugger", () => {
      lsp.attachFreightDebugger().catch((err) => {
        vscode.window.showWarningMessage(`freight Rust debugger attach failed: ${err?.message ?? err}`);
      });
    }),
    vscode.commands.registerCommand("freight.openDepDoc", (name) => {
      if (name) {
        vscode.env.openExternal(vscode.Uri.parse(`https://freight.dev/packages/${name}`));
      }
    }),
    vscode.commands.registerCommand("freight.runTarget", async (binName) => {
      await vscode.debug.startDebugging(getActiveWorkspaceFolder(), {
        type: "freight",
        request: "launch",
        name: `Freight: Run ${binName}`,
        mode: "run",
        release: state.activeProfile === "release",
        bin: binName,
        cwd: "${workspaceFolder}",
        args: [],
      });
    }),
    vscode.commands.registerCommand("freight.debugTarget", async (binName) => {
      await vscode.debug.startDebugging(getActiveWorkspaceFolder(), {
        type: "freight",
        request: "launch",
        name: `Freight: Debug ${binName}`,
        mode: "debug",
        bin: binName,
        cwd: "${workspaceFolder}",
        args: [],
      });
    })
  );
}

async function deactivate() {
  if (runtime) {
    await lsp.stopLanguageServer(runtime.state, runtime.status);
    runtime = null;
  }
}

export {
  activate,
  deactivate,
};

export const _test = {
  dapConfigPayload: debug.dapConfigPayload,
  debugRuntimePopupMessage: debug.debugRuntimePopupMessage,
  parseExecutionOutput: execution.parseExecutionOutput,
  parseDiagnosticLine: execution.parseDiagnosticLine,
  fallbackExecutionFailures: execution.fallbackExecutionFailures,
  cppTerminateMessage: execution.cppTerminateMessage,
  runtimeFailurePopupMessage: execution.runtimeFailurePopupMessage,
};
