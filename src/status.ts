import * as vscode from "vscode";
import type { ExtensionState } from "./state";

// Owns all status bar rendering. Other modules update state, then call refresh
// with a coarse phase such as idle/building/ok/fail.
interface StatusController {
  state: ExtensionState;
  docIndexCount: number;
  docIndexFlashTimer: ReturnType<typeof setTimeout> | null;
  sbBuild: import("vscode").StatusBarItem;
  sbTarget: import("vscode").StatusBarItem;
  sbSysroot: import("vscode").StatusBarItem;
  sbFamily: import("vscode").StatusBarItem;
  sbDocIndex: import("vscode").StatusBarItem;
  refresh: (phase: string) => void;
  renderDocIndex: (flash?: string) => void;
  setDocIndexCount: (count: number) => void;
}

function createStatusController(context: import("vscode").ExtensionContext, state: ExtensionState): StatusController {
  const controller: StatusController = {
    state,
    docIndexCount: 0,
    docIndexFlashTimer: null,
    sbBuild: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 54),
    sbTarget: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 53),
    sbSysroot: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 52),
    sbFamily: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 51),
    sbDocIndex: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100),
    refresh: () => {},
    renderDocIndex: () => {},
    setDocIndexCount: () => {},
  };

  controller.sbBuild.command = "freight.toggleProfile";
  controller.sbTarget.command = "freight.pickTarget";
  controller.sbSysroot.command = "freight.pickSysroot";
  controller.sbFamily.command = "freight.pickFamily";
  controller.sbDocIndex.tooltip = "Freight doc index - number of documented symbols indexed";

  for (const item of [
    controller.sbBuild,
    controller.sbTarget,
    controller.sbSysroot,
    controller.sbFamily,
    controller.sbDocIndex,
  ]) {
    item.show();
    context.subscriptions.push(item);
  }
  controller.refresh = (phase: string) => refreshStatusBars(controller, phase);
  controller.renderDocIndex = (flash?: string) => renderDocIndexBar(controller, flash);
  controller.setDocIndexCount = (count: number) => setDocIndexCount(controller, count);

  controller.renderDocIndex();
  controller.refresh("idle");
  return controller;
}

function registerTaskStatusTracking(context: import("vscode").ExtensionContext, status: StatusController) {
  context.subscriptions.push(
    vscode.tasks.onDidStartTask((event) => {
      if (event.execution.task.source === "freight") status.refresh("building");
    }),
    vscode.tasks.onDidEndTask((event) => {
      if (event.execution.task.source === "freight") status.refresh("idle");
    }),
    vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task.source === "freight") {
        status.refresh(event.exitCode === 0 ? "ok" : "fail");
      }
    })
  );
}

function refreshStatusBars(controller: StatusController, phase: string) {
  const { state } = controller;
  const profile = state.activeProfile === "release" ? " [release]" : "";

  switch (phase) {
    case "building":
      controller.sbBuild.text = `$(sync~spin) Freight${profile}`;
      controller.sbBuild.tooltip = "Freight - building...";
      break;
    case "ok":
      controller.sbBuild.text = `$(check) Freight${profile}`;
      controller.sbBuild.tooltip = "Freight - last build succeeded. Click to switch profile.";
      break;
    case "fail":
      controller.sbBuild.text = `$(error) Freight${profile}`;
      controller.sbBuild.tooltip = "Freight - last build failed. Click to switch profile.";
      break;
    default:
      controller.sbBuild.text = `$(package) Freight${profile}`;
      controller.sbBuild.tooltip = "Freight - click to switch profile (dev / release)";
  }

  controller.sbTarget.text = `$(run) ${state.activeTarget ?? "[no target]"}`;
  controller.sbTarget.tooltip = state.activeTarget
    ? `Active target: ${state.activeTarget} - click to change`
    : "No target selected - click to pick a binary";

  if (state.activeSysroot) {
    const short = state.activeSysroot.length > 24
      ? `...${state.activeSysroot.slice(-22)}`
      : state.activeSysroot;
    controller.sbSysroot.text = `$(server-environment) ${short}`;
    controller.sbSysroot.tooltip = `Sysroot: ${state.activeSysroot} - click to change`;
  } else {
    controller.sbSysroot.text = "$(server-environment) [no sysroot]";
    controller.sbSysroot.tooltip = "No sysroot - click to set cross-compile sysroot";
  }

  controller.sbFamily.text = `$(chip) ${state.activeFamily ?? "auto"}`;
  controller.sbFamily.tooltip = state.activeFamily
    ? `Compiler family: ${state.activeFamily} - click to change`
    : "Compiler family: auto-detect - click to override";
}

function renderDocIndexBar(controller: StatusController, flash?: string) {
  if (!controller.sbDocIndex) return;
  if (flash === "updated") {
    controller.sbDocIndex.text = `$(check) ${controller.docIndexCount} refs`;
    controller.sbDocIndex.color = new vscode.ThemeColor("statusBarItem.prominentForeground");
  } else {
    controller.sbDocIndex.text = `$(book) ${controller.docIndexCount} refs`;
    controller.sbDocIndex.color = undefined;
  }
}

function setDocIndexCount(controller: StatusController, count: number) {
  controller.docIndexCount = count;
  renderDocIndexBar(controller, "updated");
  if (controller.docIndexFlashTimer) clearTimeout(controller.docIndexFlashTimer);
  controller.docIndexFlashTimer = setTimeout(() => {
    renderDocIndexBar(controller);
    controller.docIndexFlashTimer = null;
  }, 2500);
}

export {
  createStatusController,
  registerTaskStatusTracking,
};

export type { StatusController };
