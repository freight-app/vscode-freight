import * as vscode from "vscode";
import * as path from "path";

import { stripAnsi, truncate } from "./utils";

// Handles Freight tasks launched from VS Code: run/build/test/etc.
// Like cpptools, these are normal shell tasks so the integrated terminal shows
// the exact Freight command and live builder output. Parsing helpers stay here
// for tests and debug-output notifications.
interface ParsedFailure {
  file: string;
  line: number;
  character: number;
  severity: "error" | "warning" | "note";
  message: string;
  code?: string;
}

interface ParsedFailureInput {
  file: string;
  line: string;
  character: string;
  severity: string;
  message: string;
  cwd: string;
}

function registerFreightTaskProvider(context: import("vscode").ExtensionContext) {
  context.subscriptions.push(vscode.tasks.registerTaskProvider("freight", new FreightTaskProvider()));
}

async function runFreightCommand(args: string[]) {
  await executeFreightTask(args, false);
}

async function runFreightTaskAndWait(args: string[]) {
  return executeFreightTask(args, true);
}

async function executeFreightTask(args: string[], waitForExit: boolean) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) {
    vscode.window.showWarningMessage("Open a Freight workspace first.");
    return undefined;
  }
  const [command, ...rest] = args;
  if (!command) {
    vscode.window.showWarningMessage("No Freight command was provided.");
    return undefined;
  }
  const task = makeFreightTask(folder, command, rest);
  const execution = await vscode.tasks.executeTask(task);
  return waitForExit ? waitForTaskProcess(execution) : undefined;
}

function waitForTaskProcess(execution: import("vscode").TaskExecution) {
  return new Promise<number | undefined>((resolve) => {
    // VS Code task execution is asynchronous. The debug adapter waits here so
    // build failures stop launch before `freight dap --no-build` starts.
    const disposable = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution !== execution) return;
      disposable.dispose();
      resolve(event.exitCode);
    });
  });
}

class FreightTaskProvider {
  provideTasks() {
    return (vscode.workspace.workspaceFolders || []).flatMap(freightTasks);
  }

  resolveTask(task: import("vscode").Task) {
    const command = typeof task.definition.command === "string" ? task.definition.command : "";
    const folder = workspaceFolderFromScope(task.scope) || (vscode.workspace.workspaceFolders || [])[0];
    if (!folder || !command) return undefined;
    const args = Array.isArray(task.definition.args)
      ? task.definition.args.map((arg) => String(arg))
      : [];
    return makeFreightTask(folder, command, args);
  }
}

function workspaceFolderFromScope(scope: import("vscode").Task["scope"]) {
  return scope && typeof scope === "object" && "uri" in scope
    ? scope as import("vscode").WorkspaceFolder
    : undefined;
}

function freightTasks(folder: import("vscode").WorkspaceFolder) {
  return [
    makeFreightTask(folder, "build", [], vscode.TaskGroup.Build),
    makeFreightTask(folder, "build", ["--release"]),
    makeFreightTask(folder, "run", []),
    makeFreightTask(folder, "test", [], vscode.TaskGroup.Test),
    makeFreightTask(folder, "fetch", []),
    makeFreightTask(folder, "clean", []),
    makeFreightTask(folder, "compile-commands", []),
  ];
}

function makeFreightTask(
  folder: import("vscode").WorkspaceFolder,
  command: string,
  args: string[],
  group?: import("vscode").TaskGroup
) {
  const config = vscode.workspace.getConfiguration("freight");
  const freight = config.get<string>("executablePath", "freight");
  const label = `freight ${[command, ...args].join(" ")}`.trim();
  const execution = new vscode.ShellExecution(freight, [command, ...args], {
    cwd: folder.uri.fsPath,
  });
  const task = new vscode.Task(
    { type: "freight", command, args },
    folder,
    label,
    "freight",
    execution,
    "$freight"
  );
  if (group) task.group = group;
  task.detail = `Runs ${label} in ${folder.name}`;
  return task;
}

function parseExecutionOutput(output: string, cwd: string): ParsedFailure[] {
  const lines = stripAnsi(output).split(/\r?\n/);
  const diagnostics = [];
  const seen = new Set();
  let lastSeverity = "error";
  let lastTopLevelMessage = "";

  for (const line of lines) {
    const top = /^(fatal error|error|warning|note):\s+(.*)$/i.exec(line.trim());
    if (top) {
      lastSeverity = normalizeSeverity(top[1]);
      lastTopLevelMessage = top[2].trim();
      continue;
    }

    const parsed = parseDiagnosticLine(line, cwd, lastSeverity, lastTopLevelMessage);
    if (!parsed) continue;
    const key = `${parsed.file}:${parsed.line}:${parsed.character}:${parsed.severity}:${parsed.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push(parsed);
  }

  return diagnostics;
}

// Supports clang/gcc, MSVC, and Freight's own indented summary location format.
function parseDiagnosticLine(
  line: string,
  cwd: string,
  fallbackSeverity = "error",
  fallbackMessage = ""
): ParsedFailure | null {
  const text = line.trimEnd();
  let match = /^(.+):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.*)$/i.exec(text);
  if (match) {
    return makeParsedFailure({
      file: match[1],
      line: match[2],
      character: match[3],
      severity: match[4],
      message: match[5],
      cwd,
    });
  }

  match = /^(.+?)\((\d+)(?:,(\d+))?\):\s*(fatal error|error|warning|note)(?:\s+[A-Za-z]+\d+)?:\s*(.*)$/i.exec(text);
  if (match) {
    return makeParsedFailure({
      file: match[1],
      line: match[2],
      character: match[3] || "1",
      severity: match[4],
      message: match[5],
      cwd,
    });
  }

  match = /^\s+(.+):(\d+):(\d+)\s+(.*)$/.exec(text);
  if (match) {
    const message = (match[4] || fallbackMessage || "Freight command failed").trim();
    return makeParsedFailure({
      file: match[1],
      line: match[2],
      character: match[3],
      severity: fallbackSeverity,
      message,
      cwd,
    });
  }

  return null;
}

function makeParsedFailure({ file, line, character, severity, message, cwd }: ParsedFailureInput): ParsedFailure | null {
  const resolved = resolveDiagnosticPath(file, cwd);
  if (!resolved) return null;
  const parsedLine = Number.parseInt(line, 10);
  const parsedCharacter = Number.parseInt(character, 10);
  if (!Number.isFinite(parsedLine) || parsedLine <= 0) return null;
  return {
    file: resolved,
    line: parsedLine,
    character: Number.isFinite(parsedCharacter) && parsedCharacter > 0 ? parsedCharacter : 1,
    severity: normalizeSeverity(severity),
    message: cleanDiagnosticMessage(message),
  };
}

function resolveDiagnosticPath(file: string, cwd: string) {
  if (!file) return null;
  const trimmed = file.trim().replace(/^"|"$/g, "");
  if (!trimmed || trimmed.startsWith("<")) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      const uri = vscode.Uri.parse(trimmed);
      return uri.scheme === "file" ? uri.fsPath : null;
    } catch {
      return null;
    }
  }
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
}

function fallbackExecutionFailures(
  args: string[],
  cwd: string,
  exitCode: number,
  signal: NodeJS.Signals | null,
  output: string
): ParsedFailure[] {
  const runtimeMessage = cppTerminateMessage(output);
  if (exitCode === 0 && !signal && !runtimeMessage) return [];
  const target = path.join(cwd, "freight.toml");
  const descriptor = runtimeMessage && exitCode === 0 && !signal
    ? "runtime error"
    : signal ? `terminated by signal ${signal}` : `exited with code ${exitCode}`;
  const last = runtimeMessage || lastMeaningfulLine(output);
  const command = args && args.length > 0 ? `freight ${args.join(" ")}` : "freight";
  const detail = last ? `${descriptor}: ${last}` : descriptor;
  return [{
    file: target,
    line: 1,
    character: 1,
    severity: "error",
    message: `${command} ${detail}`,
  }];
}

function runtimeFailurePopupMessage(
  args: string[],
  exitCode: number,
  signal: NodeJS.Signals | null,
  output: string
): string | null {
  // clangd cannot see runtime stderr. Debug output trackers use this parser
  // when a native adapter forwards stderr as DAP output events.
  const command = Array.isArray(args) ? args[0] : "";
  if (command !== "run" && command !== "test") return null;

  const cppMessage = cppTerminateMessage(output);
  if (cppMessage) return cppMessage;
  if (exitCode === 0 && !signal) return null;
  if (signal) return `freight ${args.join(" ")} terminated by signal ${signal}`;
  return null;
}

function cppTerminateMessage(output: string): string | null {
  // libstdc++/libc++ abort output usually arrives as two lines: exception type,
  // then optional what(). Fold both into a compact VS Code notification.
  const lines = stripAnsi(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^terminate called after throwing an instance of ['"`]([^'"`]+)['"`]/.exec(lines[i]);
    if (!match) continue;

    const exceptionType = match[1];
    const what = lines.slice(i + 1, i + 5)
      .map((line) => /^what\(\):\s*(.*)$/.exec(line))
      .find(Boolean);
    return what && what[1]
      ? `Unhandled C++ exception ${exceptionType}: ${what[1]}`
      : `Unhandled C++ exception ${exceptionType}`;
  }
  return null;
}

function lastMeaningfulLine(output: string) {
  const lines = stripAnsi(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (/^\^+/.test(line)) continue;
    if (/^[-=]{3,}$/.test(line)) continue;
    return truncate(line, 240);
  }
  return "";
}

function normalizeSeverity(severity: string): ParsedFailure["severity"] {
  const lower = String(severity || "error").toLowerCase();
  if (lower.includes("warning")) return "warning";
  if (lower.includes("note")) return "note";
  return "error";
}

function cleanDiagnosticMessage(message: string) {
  return String(message || "Freight command failed").trim() || "Freight command failed";
}

export {
  FreightTaskProvider,
  cppTerminateMessage,
  fallbackExecutionFailures,
  makeFreightTask,
  parseDiagnosticLine,
  parseExecutionOutput,
  registerFreightTaskProvider,
  runFreightCommand,
  runFreightTaskAndWait,
  runtimeFailurePopupMessage,
};
