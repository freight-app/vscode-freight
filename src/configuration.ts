import * as vscode from "vscode";

import { ALL_FAMILIES } from "./state";
import type { ExtensionState } from "./state";
import type { StatusController } from "./status";

// Registers commands that mutate extension/workspace configuration, such as the
// active profile, target, sysroot, and compiler family shown in the status bar.
interface LspApi {
  getClient: () => any;
  startLanguageServer: (
    context: import("vscode").ExtensionContext,
    state: ExtensionState,
    status: StatusController
  ) => Promise<void>;
  stopLanguageServer: (state: ExtensionState, status: StatusController) => Promise<void>;
}

function registerConfigurationCommands(
  context: import("vscode").ExtensionContext,
  state: ExtensionState,
  status: StatusController,
  lsp: LspApi
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("freight.toggleProfile", async () => {
      const profiles: string[] = state.explorerProvider?.getProfiles() ?? ["dev", "release"];
      const descriptions: Record<string, string> = { dev: "Debug build (default)", release: "Optimised release build" };
      const items = profiles.map((profile) => ({
        label: (profile === state.activeProfile ? "$(check) " : "        ") + profile,
        description: descriptions[profile] ?? "Custom profile",
        value: profile,
      }));
      const choice = await vscode.window.showQuickPick<typeof items[number]>(items, {
        placeHolder: `Active profile: ${state.activeProfile}`,
      });
      if (choice) {
        state.activeProfile = choice.value;
        await context.workspaceState.update("freight.profile", state.activeProfile);
        status.refresh("idle");
      }
    }),
    vscode.commands.registerCommand("freight.pickTarget", async () => {
      const bins: string[] = state.explorerProvider?.getBinNames() ?? [];
      const items = [
        { label: "$(search) auto", description: "Let freight select the binary", value: null },
        ...bins.map((bin) => ({ label: `$(run) ${bin}`, description: "", value: bin })),
      ];
      const choice = await vscode.window.showQuickPick<typeof items[number]>(items, {
        placeHolder: `Active target: ${state.activeTarget ?? "auto"}`,
      });
      if (choice !== undefined) {
        state.activeTarget = choice.value;
        await context.workspaceState.update("freight.target", state.activeTarget);
        status.refresh("idle");
      }
    }),
    vscode.commands.registerCommand("freight.pickSysroot", async () => {
      const input = await vscode.window.showInputBox({
        prompt: "Sysroot path (leave empty to clear)",
        value: state.activeSysroot ?? "",
        placeHolder: "/path/to/sysroot or empty to disable",
      });
      if (input !== undefined) {
        state.activeSysroot = input.trim() || null;
        await context.workspaceState.update("freight.sysroot", state.activeSysroot);
        const client = lsp.getClient();
        if (client) {
          client.sendRequest("freight/setConfig", {
            key: "compiler.sysroot",
            value: state.activeSysroot ?? null,
          }).catch(() => {});
        }
        status.refresh("idle");
      }
    }),
    vscode.commands.registerCommand("freight.pickFamily", async () => {
      const available = state.detectedFamilies ?? ALL_FAMILIES.map((family) => family.label);
      const items = ALL_FAMILIES
        .filter((family) => available.includes(family.label))
        .map((family) => ({
          ...family,
          label: (family.label === (state.activeFamily ?? "auto") ? "$(check) " : "        ") + family.label,
          value: family.label === "auto" ? null : family.label,
        }));
      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: `Compiler family: ${state.activeFamily ?? "auto"}`,
      });
      if (choice !== undefined) {
        state.activeFamily = choice.value;
        await context.workspaceState.update("freight.family", state.activeFamily);
        status.refresh("idle");
      }
    })
  );
}

function registerConfigurationWatcher(
  context: import("vscode").ExtensionContext,
  state: ExtensionState,
  status: StatusController,
  lsp: LspApi
) {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("freight.lsp") || event.affectsConfiguration("freight.executablePath")) {
        await lsp.stopLanguageServer(state, status);
        await lsp.startLanguageServer(context, state, status);
      }
    })
  );
}

export {
  registerConfigurationCommands,
  registerConfigurationWatcher,
};
