const vscode = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");

let client;
let statusBar;

function activate(context) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.text = "$(package) Freight";
  statusBar.tooltip = "Freight";
  statusBar.command = "freight.generateCompileCommands";
  statusBar.show();
  context.subscriptions.push(statusBar);

  const taskProvider = new FreightTaskProvider();
  context.subscriptions.push(vscode.tasks.registerTaskProvider("freight", taskProvider));
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider("freight", new FreightDebugProvider()));
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory("freight", new FreightDebugAdapterFactory()));

  context.subscriptions.push(
    vscode.commands.registerCommand("freight.restartLanguageServer", async () => {
      await stopLanguageServer();
      await startLanguageServer(context);
    }),
    vscode.commands.registerCommand("freight.generateCompileCommands", async () => {
      await runFreightCommand(["compile-commands"]);
    }),
    vscode.commands.registerCommand("freight.run", async () => {
      await runFreightCommand(["run"]);
    }),
    vscode.commands.registerCommand("freight.debug", async () => {
      await vscode.debug.startDebugging(getActiveWorkspaceFolder(), {
        type: "freight",
        request: "launch",
        name: "Freight: Debug",
        mode: "debug",
        cwd: "${workspaceFolder}",
        args: []
      });
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("freight.lsp") || event.affectsConfiguration("freight.executablePath")) {
        await stopLanguageServer();
        await startLanguageServer(context);
      }
    })
  );

  startLanguageServer(context);
}

function getActiveWorkspaceFolder() {
  const active = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
  if (active) {
    return vscode.workspace.getWorkspaceFolder(active);
  }
  return (vscode.workspace.workspaceFolders || [])[0];
}

async function deactivate() {
  await stopLanguageServer();
}

async function startLanguageServer(context) {
  const config = vscode.workspace.getConfiguration("freight");
  if (!config.get("lsp.enabled", true)) {
    setStatus("$(package) Freight");
    return;
  }

  const freight = config.get("executablePath", "freight");
  const args = ["lsp"];

  appendIfChanged(args, "--profile", config.get("lsp.profile", "dev"), "dev");
  appendIfChanged(args, "--clangd", config.get("lsp.clangdPath", "clangd"), "clangd");
  appendIfChanged(args, "--fortls", config.get("lsp.fortlsPath", "fortls"), "fortls");
  appendIfChanged(args, "--asm-lsp", config.get("lsp.asmLspPath", "asm-lsp"), "asm-lsp");

  if (!config.get("lsp.enableClangd", true)) {
    args.push("--no-clangd");
  }
  if (!config.get("lsp.enableFortls", true)) {
    args.push("--no-fortls");
  }
  if (!config.get("lsp.enableAsmLsp", true)) {
    args.push("--no-asm-lsp");
  }

  client = new LanguageClient(
    "freight",
    "Freight",
    {
      command: freight,
      args
    },
    {
      documentSelector: freightDocumentSelector(),
      synchronize: {
        fileEvents: vscode.workspace.createFileSystemWatcher("**/freight.toml")
      },
      outputChannelName: "Freight Language Server"
    }
  );

  context.subscriptions.push(client);
  setStatus("$(sync~spin) Freight LSP");
  try {
    await client.start();
    setStatus("$(check) Freight LSP");
  } catch (error) {
    setStatus("$(error) Freight LSP");
    vscode.window.showWarningMessage(`Could not start freight lsp: ${error.message || error}`);
  }
}

function appendIfChanged(args, flag, value, defaultValue) {
  if (value && value !== defaultValue) {
    args.push(flag, value);
  }
}

async function stopLanguageServer() {
  if (!client) {
    return;
  }
  const old = client;
  client = undefined;
  await old.stop();
  setStatus("$(package) Freight");
}

function freightDocumentSelector() {
  const sourcePatterns = [
    "**/*.{c,h,cc,hh,cpp,hpp,cxx,hxx,c++,h++,cppm,ixx,mpp}",
    "**/*.{cu,cuh,hip,m,mm}",
    "**/*.{f,for,f90,f95,f03,f08}",
    "**/*.{asm,nasm,s,S}"
  ];
  return [
    { language: "freight-manifest", scheme: "file" },
    ...sourcePatterns.map((pattern) => ({ scheme: "file", pattern }))
  ];
}

async function runFreightCommand(args) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) {
    vscode.window.showWarningMessage("Open a Freight workspace first.");
    return;
  }

  const config = vscode.workspace.getConfiguration("freight");
  const execution = new vscode.ShellExecution(config.get("executablePath", "freight"), args, {
    cwd: folder.uri.fsPath
  });
  const task = new vscode.Task(
    { type: "freight", command: args.join(" ") },
    folder,
    `freight ${args.join(" ")}`,
    "freight",
    execution,
    "$freight"
  );
  await vscode.tasks.executeTask(task);
}

function setStatus(text) {
  if (statusBar) {
    statusBar.text = text;
  }
}

class FreightTaskProvider {
  provideTasks() {
    const folders = vscode.workspace.workspaceFolders || [];
    return folders.flatMap((folder) => freightTasks(folder));
  }

  resolveTask(task) {
    const command = task.definition.command;
    const folder = task.scope && task.scope.uri ? task.scope : (vscode.workspace.workspaceFolders || [])[0];
    if (!folder || !command) {
      return undefined;
    }
    return makeFreightTask(folder, command, task.definition.args || []);
  }
}

class FreightDebugProvider {
  resolveDebugConfiguration(folder, config) {
    const workspaceFolder = folder || getActiveWorkspaceFolder();
    if (!workspaceFolder) {
      vscode.window.showWarningMessage("Open a Freight workspace before launching a Freight debug configuration.");
      return undefined;
    }

    const mode = config.mode || "run";
    return {
      ...config,
      type: "freight",
      request: "launch",
      name: config.name || (mode === "debug" ? "Freight: Debug" : "Freight: Run"),
      mode,
      cwd: resolveCwd(config.cwd, workspaceFolder),
      args: Array.isArray(config.args) ? config.args : []
    };
  }
}

class FreightDebugAdapterFactory {
  createDebugAdapterDescriptor() {
    return new vscode.DebugAdapterInlineImplementation(new FreightTerminalDebugAdapter());
  }
}

class FreightTerminalDebugAdapter {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidSendMessage = this.emitter.event;
  }

  handleMessage(message) {
    switch (message.command) {
      case "initialize":
        this.sendResponse(message, {
          supportsConfigurationDoneRequest: true
        });
        this.sendEvent("initialized");
        break;
      case "launch":
        this.launch(message);
        break;
      case "configurationDone":
      case "threads":
        this.sendResponse(message, message.command === "threads" ? { threads: [] } : {});
        break;
      case "disconnect":
        this.sendResponse(message, {});
        this.sendEvent("terminated");
        break;
      default:
        this.sendResponse(message, {});
        break;
    }
  }

  launch(message) {
    const config = message.arguments || {};
    const mode = config.mode || "run";
    const freightArgs = mode === "debug" ? debugArgs(config) : runArgs(config);
    const freight = vscode.workspace.getConfiguration("freight").get("executablePath", "freight");
    const terminal = vscode.window.createTerminal({
      name: config.name || (mode === "debug" ? "Freight: Debug" : "Freight: Run"),
      cwd: config.cwd || undefined
    });
    terminal.show();
    terminal.sendText(commandLine(freight, freightArgs), true);
    this.sendResponse(message, {});
  }

  sendResponse(request, body) {
    this.emitter.fire({
      type: "response",
      seq: 0,
      request_seq: request.seq,
      success: true,
      command: request.command,
      body
    });
  }

  sendEvent(event, body) {
    this.emitter.fire({
      type: "event",
      seq: 0,
      event,
      body
    });
  }

  dispose() {
    this.emitter.dispose();
  }
}

function runArgs(config) {
  const args = ["run"];
  if (config.release) {
    args.push("--release");
  }
  if (config.package) {
    args.push("-p", config.package);
  }
  if (config.bin) {
    args.push("--bin", config.bin);
  }
  if (Array.isArray(config.features) && config.features.length > 0) {
    args.push("--features", config.features.join(","));
  }
  if (config.noDefaultFeatures) {
    args.push("--no-default-features");
  }
  appendProgramArgs(args, config.args);
  return args;
}

function debugArgs(config) {
  const args = ["debug"];
  if (config.bin) {
    args.push(config.bin);
  }
  if (config.debugger) {
    args.push("--debugger", config.debugger);
  }
  appendProgramArgs(args, config.args);
  return args;
}

function appendProgramArgs(args, programArgs) {
  if (Array.isArray(programArgs) && programArgs.length > 0) {
    args.push("--", ...programArgs);
  }
}

function resolveCwd(cwd, folder) {
  if (!cwd || cwd === "${workspaceFolder}") {
    return folder.uri.fsPath;
  }
  return cwd.replace("${workspaceFolder}", folder.uri.fsPath);
}

function commandLine(command, args) {
  return [command, ...args].map(shellQuote).join(" ");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function freightTasks(folder) {
  return [
    makeFreightTask(folder, "build", [], vscode.TaskGroup.Build),
    makeFreightTask(folder, "build", ["--release"]),
    makeFreightTask(folder, "run", []),
    makeFreightTask(folder, "test", [], vscode.TaskGroup.Test),
    makeFreightTask(folder, "fetch", []),
    makeFreightTask(folder, "clean", []),
    makeFreightTask(folder, "compile-commands", [])
  ];
}

function makeFreightTask(folder, command, args, group) {
  const config = vscode.workspace.getConfiguration("freight");
  const freight = config.get("executablePath", "freight");
  const label = `freight ${[command, ...args].join(" ")}`.trim();
  const execution = new vscode.ShellExecution(freight, [command, ...args], {
    cwd: folder.uri.fsPath
  });
  const task = new vscode.Task(
    { type: "freight", command, args },
    folder,
    label,
    "freight",
    execution,
    "$freight"
  );
  if (group) {
    task.group = group;
  }
  return task;
}

module.exports = {
  activate,
  deactivate
};
