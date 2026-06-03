const vscode = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");
const { FreightExplorerProvider } = require("./explorer");

let client;
let statusBar;
let explorerProvider;
// "dev" | "release" — persisted in workspace state
let activeProfile = "dev";

function activate(context) {
  activeProfile = context.workspaceState.get("freight.profile", "dev");

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = "freight.toggleProfile";
  updateStatusBar("idle");
  statusBar.show();
  context.subscriptions.push(statusBar);

  const taskProvider = new FreightTaskProvider();
  context.subscriptions.push(vscode.tasks.registerTaskProvider("freight", taskProvider));
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider("freight", new FreightDebugProvider()));
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory("freight", new FreightDebugAdapterFactory()));

  // Explorer panel
  explorerProvider = new FreightExplorerProvider(context);
  const explorerView = vscode.window.createTreeView("freight.explorerView", {
    treeDataProvider: explorerProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(explorerView);

  // Track build results via task end events
  context.subscriptions.push(
    vscode.tasks.onDidStartTask((e) => {
      if (e.execution.task.source === "freight") {
        updateStatusBar("building");
      }
    }),
    vscode.tasks.onDidEndTask((e) => {
      if (e.execution.task.source === "freight") {
        updateStatusBar("idle");
      }
    }),
    vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution.task.source === "freight") {
        updateStatusBar(e.exitCode === 0 ? "ok" : "fail");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("freight.restartLanguageServer", async () => {
      await stopLanguageServer();
      await startLanguageServer(context);
    }),
    vscode.commands.registerCommand("freight.generateCompileCommands", async () => {
      await runFreightCommand(["compile-commands"]);
    }),
    vscode.commands.registerCommand("freight.run", async () => {
      await vscode.debug.startDebugging(getActiveWorkspaceFolder(), {
        type: "freight",
        request: "launch",
        name: "Freight: Run",
        mode: "run",
        release: activeProfile === "release",
        cwd: "${workspaceFolder}",
        args: []
      });
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
    vscode.commands.registerCommand("freight.toggleProfile", async () => {
      const choice = await vscode.window.showQuickPick(
        [
          { label: "dev", description: "Debug build (default)" },
          { label: "release", description: "Optimised release build" },
        ],
        { placeHolder: `Active profile: ${activeProfile}` }
      );
      if (choice) {
        activeProfile = choice.label;
        await context.workspaceState.update("freight.profile", activeProfile);
        updateStatusBar("idle");
      }
    }),
    vscode.commands.registerCommand("freight.refreshExplorer", () => {
      explorerProvider.refresh();
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
        release: activeProfile === "release",
        bin: binName,
        cwd: "${workspaceFolder}",
        args: []
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

function updateStatusBar(state) {
  const profile = activeProfile === "release" ? " [release]" : "";
  switch (state) {
    case "building":
      statusBar.text = `$(sync~spin) Freight${profile}`;
      statusBar.tooltip = "Freight — building…";
      break;
    case "ok":
      statusBar.text = `$(check) Freight${profile}`;
      statusBar.tooltip = "Freight — last build succeeded. Click to switch profile.";
      break;
    case "fail":
      statusBar.text = `$(error) Freight${profile}`;
      statusBar.tooltip = "Freight — last build failed. Click to switch profile.";
      break;
    default:
      statusBar.text = `$(package) Freight${profile}`;
      statusBar.tooltip = "Freight — click to switch profile (dev/release)";
  }
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
    updateStatusBar("idle");
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
  updateStatusBar("building");
  try {
    await client.start();
    updateStatusBar("ok");
  } catch (error) {
    updateStatusBar("fail");
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
  updateStatusBar("idle");
}

function freightDocumentSelector() {
  const sourcePatterns = [
    "**/*.{c,h,cc,hh,cpp,hpp,cxx,hxx,c++,h++,cppm,ixx,mpp}",
    "**/*.{cu,cuh,hip,cl,ispc,m,mm}",
    "**/*.{f,for,ftn,f77,f66,f90,f95,f03,f08,f18}",
    "**/*.{F,FOR,FTN,F77,F66,F90,F95,F03,F08,F18}",
    "**/*.{asm,nasm,s,S}"
  ];
  return [
    { language: "freight-manifest", scheme: "file" },
    { language: "c",             scheme: "file" },
    { language: "cpp",           scheme: "file" },
    { language: "cuda-cpp",      scheme: "file" },
    { language: "objective-c",   scheme: "file" },
    { language: "objective-cpp", scheme: "file" },
    { language: "fortran",        scheme: "file" },
    { language: "FortranFreeForm", scheme: "file" },
    { language: "FortranFixedForm", scheme: "file" },
    { language: "asm",  scheme: "file" },
    { language: "nasm", scheme: "file" },
    { language: "gas",  scheme: "file" },
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
      request: config.request || "launch",
      name: config.name || (mode === "debug" ? "Freight: Debug" : "Freight: Run"),
      mode,
      cwd: resolveCwd(config.cwd, workspaceFolder),
      args: Array.isArray(config.args) ? config.args : []
    };
  }

  async provideDebugConfigurations(folder) {
    const bins = await explorerProvider?.getBinNames() ?? [];
    const configs = [
      {
        name: "Freight: Run",
        type: "freight",
        request: "launch",
        mode: "run",
        cwd: "${workspaceFolder}",
        args: []
      },
      {
        name: "Freight: Debug",
        type: "freight",
        request: "launch",
        mode: "debug",
        cwd: "${workspaceFolder}",
        args: []
      }
    ];
    for (const bin of bins) {
      configs.push({
        name: `Freight: Debug ${bin}`,
        type: "freight",
        request: "launch",
        mode: "debug",
        bin,
        cwd: "${workspaceFolder}",
        args: []
      });
    }
    return configs;
  }
}

class FreightDebugAdapterFactory {
  async createDebugAdapterDescriptor(session) {
    const config = session.configuration;
    const freight = vscode.workspace.getConfiguration("freight").get("executablePath", "freight");
    const cwd = config.cwd;

    if (config.mode === "run") {
      // freight run — not a real DAP session, launch as task instead
      const folder = getActiveWorkspaceFolder();
      if (folder) {
        const resolvedConfig = await resolveBin(config);
        if (!resolvedConfig) return undefined; // user cancelled quick-pick
        const args = buildRunArgs(resolvedConfig);
        await runFreightCommand(args);
      }
      return undefined;
    }

    // Debug mode: resolve bin if multiple targets and none specified
    const resolvedConfig = await resolveBin(config);
    if (!resolvedConfig) return undefined; // user cancelled quick-pick

    // attach flag triggers --attach in freight dap
    const dapArgs = ["dap"];
    if (resolvedConfig.request === "attach") {
      dapArgs.push("--attach");
    }

    return new vscode.DebugAdapterExecutable(freight, dapArgs, cwd ? { cwd } : undefined);
  }
}

async function resolveBin(config) {
  if (config.bin || config.request === "attach") {
    return config;
  }
  const bins = explorerProvider?.getBinNames() ?? [];
  if (bins.length <= 1) {
    return config; // zero or one binary — let freight decide
  }
  const choice = await vscode.window.showQuickPick(
    bins.map((b) => ({ label: b })),
    { placeHolder: "Select binary to run" }
  );
  if (!choice) return null; // user cancelled
  return { ...config, bin: choice.label };
}

function buildRunArgs(config) {
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

function resolveCwd(cwd, folder) {
  if (!cwd || cwd === "${workspaceFolder}") {
    return folder.uri.fsPath;
  }
  return cwd.replace("${workspaceFolder}", folder.uri.fsPath);
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
