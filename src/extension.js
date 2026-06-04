const vscode = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");
const { FreightExplorerProvider } = require("./explorer");
const fs = require("fs");
const os = require("os");
const path = require("path");

const FREIGHT_LSP_PID_FILE = "/tmp/freight-lsp-debug.pid";

let client;
let explorerProvider;

// Persistent workspace state ─────────────────────────────────────────────────
let activeProfile = "dev";   // "dev" | "release"
let activeTarget  = null;    // string | null  — active [[bin]] name, null = auto
let activeSysroot = null;    // string | null  — sysroot path
let activeFamily  = null;    // "gcc" | "clang" | "msvc" | "nvcc" | null = auto

// Detected toolchains from LSP (refreshed after server starts)
let detectedFamilies = null;  // string[] | null — null = not yet queried

// Status bar items (Left, descending priority = left-to-right order) ─────────
let sbBuild;    // priority 54 — $(package) Freight [release]
let sbTarget;   // priority 53 — $(run) target
let sbSysroot;  // priority 52 — $(server-environment) sysroot
let sbFamily;   // priority 51 — $(chip) family

// Status bar item (Right) ────────────────────────────────────────────────────
let sbDocIndex;          // Right — doc reference count
let docIndexCount = 0;   // last known count
let docIndexFlashTimer = null;

const ALL_FAMILIES = [
  { label: "auto",  description: "Let freight detect the compiler" },
  { label: "gcc",   description: "GCC / g++ / gfortran" },
  { label: "clang", description: "Clang / clang++ / clang-cl" },
  { label: "msvc",  description: "MSVC (cl.exe)" },
  { label: "nvcc",  description: "NVIDIA CUDA compiler" },
];

function activate(context) {
  try {
    _activate(context);
  } catch (err) {
    vscode.window.showErrorMessage(`freight extension failed to activate: ${err?.message ?? err}`);
    throw err;
  }
}

function _activate(context) {
  activeProfile = context.workspaceState.get("freight.profile", "dev");
  activeTarget  = context.workspaceState.get("freight.target",  null);
  activeSysroot = context.workspaceState.get("freight.sysroot", null);
  activeFamily  = context.workspaceState.get("freight.family",  null);

  // ── Status bar ─────────────────────────────────────────────────────────────
  sbBuild = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 54);
  sbBuild.command = "freight.toggleProfile";
  sbBuild.show();
  context.subscriptions.push(sbBuild);

  sbTarget = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 53);
  sbTarget.command = "freight.pickTarget";
  sbTarget.show();
  context.subscriptions.push(sbTarget);

  sbSysroot = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 52);
  sbSysroot.command = "freight.pickSysroot";
  sbSysroot.show();
  context.subscriptions.push(sbSysroot);

  sbFamily = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 51);
  sbFamily.command = "freight.pickFamily";
  sbFamily.show();
  context.subscriptions.push(sbFamily);

  sbDocIndex = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  sbDocIndex.tooltip = "Freight doc index — number of documented symbols indexed";
  sbDocIndex.show();
  context.subscriptions.push(sbDocIndex);
  renderDocIndexBar();

  refreshStatusBars("idle");

  // ── Task tracking ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.tasks.onDidStartTask((e) => {
      if (e.execution.task.source === "freight") refreshStatusBars("building");
    }),
    vscode.tasks.onDidEndTask((e) => {
      if (e.execution.task.source === "freight") refreshStatusBars("idle");
    }),
    vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution.task.source === "freight") {
        refreshStatusBars(e.exitCode === 0 ? "ok" : "fail");
      }
    })
  );

  // ── Providers ──────────────────────────────────────────────────────────────
  const taskProvider = new FreightTaskProvider();
  context.subscriptions.push(vscode.tasks.registerTaskProvider("freight", taskProvider));
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider("freight", new FreightDebugProvider()));
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory("freight", new FreightDebugAdapterFactory()));

  explorerProvider = new FreightExplorerProvider(context);
  const explorerView = vscode.window.createTreeView("freight.explorerView", {
    treeDataProvider: explorerProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(explorerView);

  // Refresh target bar when manifest changes (bins may appear/disappear)
  explorerProvider.onDidRefresh(() => refreshStatusBars("idle"));

  // ── Commands ───────────────────────────────────────────────────────────────
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
        type: "freight", request: "launch", name: "Freight: Run",
        mode: "run", release: activeProfile === "release",
        cwd: "${workspaceFolder}", args: []
      });
    }),
    vscode.commands.registerCommand("freight.debug", async () => {
      await vscode.debug.startDebugging(getActiveWorkspaceFolder(), {
        type: "freight", request: "launch", name: "Freight: Debug",
        mode: "debug", cwd: "${workspaceFolder}", args: []
      });
    }),
    vscode.commands.registerCommand("freight.toggleProfile", async () => {
      const profiles = explorerProvider?.getProfiles() ?? ["dev", "release"];
      const descriptions = { dev: "Debug build (default)", release: "Optimised release build" };
      const items = profiles.map((p) => ({
        label: (p === activeProfile ? "$(check) " : "        ") + p,
        description: descriptions[p] ?? "Custom profile",
        value: p,
      }));
      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: `Active profile: ${activeProfile}`,
      });
      if (choice) {
        activeProfile = choice.value;
        await context.workspaceState.update("freight.profile", activeProfile);
        refreshStatusBars("idle");
      }
    }),
    vscode.commands.registerCommand("freight.pickTarget", async () => {
      const bins = explorerProvider?.getBinNames() ?? [];
      const items = [
        { label: "$(search) auto", description: "Let freight select the binary", value: null },
        ...bins.map((b) => ({ label: `$(run) ${b}`, description: "", value: b })),
      ];
      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: `Active target: ${activeTarget ?? "auto"}`,
      });
      if (choice !== undefined) {
        activeTarget = choice.value;
        await context.workspaceState.update("freight.target", activeTarget);
        refreshStatusBars("idle");
      }
    }),
    vscode.commands.registerCommand("freight.pickSysroot", async () => {
      const input = await vscode.window.showInputBox({
        prompt: "Sysroot path (leave empty to clear)",
        value: activeSysroot ?? "",
        placeHolder: "/path/to/sysroot or empty to disable",
      });
      if (input !== undefined) {
        activeSysroot = input.trim() || null;
        await context.workspaceState.update("freight.sysroot", activeSysroot);
        // Persist to freight.toml via LSP so it survives across sessions.
        if (client) {
          client.sendRequest("freight/setConfig", {
            key: "compiler.sysroot",
            value: activeSysroot ?? null,
          }).catch(() => {});
        }
        refreshStatusBars("idle");
      }
    }),
    vscode.commands.registerCommand("freight.pickFamily", async () => {
      // Use detected families from LSP if available; fall back to the full list.
      const available = detectedFamilies ?? ALL_FAMILIES.map((f) => f.label);
      const items = ALL_FAMILIES
        .filter((f) => available.includes(f.label))
        .map((f) => ({
          ...f,
          label: (f.label === (activeFamily ?? "auto") ? "$(check) " : "        ") + f.label,
          value: f.label === "auto" ? null : f.label,
        }));
      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: `Compiler family: ${activeFamily ?? "auto"}`,
      });
      if (choice !== undefined) {
        activeFamily = choice.value;
        await context.workspaceState.update("freight.family", activeFamily);
        refreshStatusBars("idle");
      }
    }),
    vscode.commands.registerCommand("freight.refreshExplorer", () => {
      explorerProvider.refresh();
    }),
    vscode.commands.registerCommand("freight.attachRustDebugger", () => {
      attachFreightDebugger().catch((e) => {
        vscode.window.showWarningMessage(`freight Rust debugger attach failed: ${e?.message ?? e}`);
      });
    }),
    vscode.commands.registerCommand("freight.openDepDoc", (name) => {
      if (name) {
        vscode.env.openExternal(vscode.Uri.parse(`https://freight.dev/packages/${name}`));
      }
    }),
    vscode.commands.registerCommand("freight.runTarget", async (binName) => {
      await vscode.debug.startDebugging(getActiveWorkspaceFolder(), {
        type: "freight", request: "launch", name: `Freight: Run ${binName}`,
        mode: "run", release: activeProfile === "release", bin: binName,
        cwd: "${workspaceFolder}", args: []
      });
    }),
    vscode.commands.registerCommand("freight.debugTarget", async (binName) => {
      await vscode.debug.startDebugging(getActiveWorkspaceFolder(), {
        type: "freight", request: "launch", name: `Freight: Debug ${binName}`,
        mode: "debug", bin: binName, cwd: "${workspaceFolder}", args: []
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
}   // end _activate

// ── Status bar rendering ─────────────────────────────────────────────────────

function refreshStatusBars(state) {
  // Build / profile bar
  const profile = activeProfile === "release" ? " [release]" : "";
  switch (state) {
    case "building":
      sbBuild.text = `$(sync~spin) Freight${profile}`;
      sbBuild.tooltip = "Freight — building…";
      break;
    case "ok":
      sbBuild.text = `$(check) Freight${profile}`;
      sbBuild.tooltip = "Freight — last build succeeded. Click to switch profile.";
      break;
    case "fail":
      sbBuild.text = `$(error) Freight${profile}`;
      sbBuild.tooltip = "Freight — last build failed. Click to switch profile.";
      break;
    default:
      sbBuild.text = `$(package) Freight${profile}`;
      sbBuild.tooltip = "Freight — click to switch profile (dev / release)";
  }

  // Target bar
  sbTarget.text = `$(run) ${activeTarget ?? "[no target]"}`;
  sbTarget.tooltip = activeTarget
    ? `Active target: ${activeTarget} — click to change`
    : "No target selected — click to pick a binary";

  // Sysroot bar
  if (activeSysroot) {
    const short = activeSysroot.length > 24 ? `…${activeSysroot.slice(-22)}` : activeSysroot;
    sbSysroot.text = `$(server-environment) ${short}`;
    sbSysroot.tooltip = `Sysroot: ${activeSysroot} — click to change`;
  } else {
    sbSysroot.text = "$(server-environment) [no sysroot]";
    sbSysroot.tooltip = "No sysroot — click to set cross-compile sysroot";
  }

  // Family bar
  sbFamily.text = `$(chip) ${activeFamily ?? "auto"}`;
  sbFamily.tooltip = activeFamily
    ? `Compiler family: ${activeFamily} — click to change`
    : "Compiler family: auto-detect — click to override";
}

function renderDocIndexBar(flash) {
  if (!sbDocIndex) return;
  if (flash === "updated") {
    sbDocIndex.text = `$(check) ${docIndexCount} refs`;
    sbDocIndex.color = new vscode.ThemeColor("statusBarItem.prominentForeground");
  } else {
    sbDocIndex.text = `$(book) ${docIndexCount} refs`;
    sbDocIndex.color = undefined;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getActiveWorkspaceFolder() {
  const active = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
  if (active) return vscode.workspace.getWorkspaceFolder(active);
  return (vscode.workspace.workspaceFolders || [])[0];
}

async function deactivate() {
  await stopLanguageServer();
}

async function startLanguageServer(context) {
  const config = vscode.workspace.getConfiguration("freight");
  if (!config.get("lsp.enabled", true)) {
    refreshStatusBars("idle");
    return;
  }

  const freight = config.get("executablePath", "freight");
  const args = ["lsp"];

  appendIfChanged(args, "--profile", config.get("lsp.profile", "dev"), "dev");
  appendIfChanged(args, "--clangd", config.get("lsp.clangdPath", "clangd"), "clangd");
  appendIfChanged(args, "--fortls", config.get("lsp.fortlsPath", "fortls"), "fortls");
  appendIfChanged(args, "--asm-lsp", config.get("lsp.asmLspPath", "asm-lsp"), "asm-lsp");

  if (!config.get("lsp.enableClangd", true))  args.push("--no-clangd");
  if (!config.get("lsp.enableFortls", true))   args.push("--no-fortls");
  if (!config.get("lsp.enableAsmLsp", true))   args.push("--no-asm-lsp");

  const isDev = context.extensionMode === vscode.ExtensionMode.Development;

  // Resolve log level: explicit setting wins; fall back to "debug" in
  // extension development mode (F5) so logs appear automatically.
  const cfgLogLevel = config.get("lsp.logLevel", "");
  const logLevel = cfgLogLevel || (isDev ? "debug" : "");

  const serverEnv = logLevel
    ? { ...process.env, FREIGHT_LOG: logLevel }
    : undefined;

  // In development mode run via `cargo run` so the binary has debug symbols
  // and breakpoints work in the Rust source. In production use the installed binary.
  const extensionRoot = path.resolve(__dirname, "..");
  const cargoWorkspace = path.resolve(extensionRoot, "../..");
  const serverOptions = isDev
    ? { command: "cargo", args: ["run", "-p", "freight", "--", ...args], options: { cwd: cargoWorkspace, env: serverEnv } }
    : { command: freight, args, options: { env: serverEnv } };

  client = new LanguageClient(
    "freight", "Freight",
    serverOptions,
    {
      documentSelector: freightDocumentSelector(),
      synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher("**/freight.toml") },
      outputChannelName: "Freight Language Server"
    }
  );

  client.onNotification("freight/docIndexUpdated", (params) => {
    const count = params && typeof params.items === "number" ? params.items : 0;
    docIndexCount = count;
    renderDocIndexBar("updated");
    if (docIndexFlashTimer) clearTimeout(docIndexFlashTimer);
    docIndexFlashTimer = setTimeout(() => {
      renderDocIndexBar();
      docIndexFlashTimer = null;
    }, 2500);
  });

  context.subscriptions.push(client);
  refreshStatusBars("building");
  try {
    await client.start();
    refreshStatusBars("ok");
    // Query workspace info to get detected toolchains and current sysroot.
    queryWorkspaceInfo(context).catch(() => {});
  } catch (error) {
    refreshStatusBars("fail");
    vscode.window.showWarningMessage(`Could not start freight lsp: ${error.message || error}`);
  }
}

function appendIfChanged(args, flag, value, defaultValue) {
  if (value && value !== defaultValue) args.push(flag, value);
}

/** Find the PID of the running freight LSP process and attach CodeLLDB. */
async function attachFreightDebugger() {
  // Try the PID file first (written when --wait-for-debugger is passed).
  let pid;
  try {
    const content = fs.readFileSync(FREIGHT_LSP_PID_FILE, "utf8").trim();
    const n = parseInt(content, 10);
    if (n > 0) pid = n;
  } catch { /* no file — server running normally */ }

  // Fall back: find the process by scanning /proc for a freight lsp cmdline.
  if (!pid) {
    pid = findFreightLspPid();
  }

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

/** Scan /proc for the freight LSP process.
 *  Matches both the installed binary ("freight lsp") and the cargo-run
 *  debug binary (".../target/debug/freight lsp"). */
function findFreightLspPid() {
  try {
    const entries = fs.readdirSync("/proc").filter((e) => /^\d+$/.test(e));
    for (const entry of entries) {
      try {
        const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
        const parts = cmdline.split("\0").filter(Boolean);
        const exe = parts[0] || "";
        const isFreight = exe === "freight" || exe.endsWith("/freight") || exe.endsWith("/debug/freight");
        if (isFreight && parts.includes("lsp")) {
          return parseInt(entry, 10);
        }
      } catch { /* process gone or no permission */ }
    }
  } catch { /* not Linux */ }
  return null;
}

/** Query `freight/workspaceInfo` from the running LSP client.
 *  Updates `detectedFamilies` and initialises `activeSysroot` from the manifest
 *  if it hasn't been overridden by the user in this session. */
async function queryWorkspaceInfo(context) {
  if (!client) return;
  const info = await client.sendRequest("freight/workspaceInfo");
  if (!info) return;

  // Update detected family list (always "auto" + whatever the LSP found).
  if (Array.isArray(info.toolchains)) {
    detectedFamilies = ["auto", ...info.toolchains.map((tc) => tc.family)];
  }

  // Seed sysroot from freight.toml if the user hasn't set one locally yet.
  const savedSysroot = context.workspaceState.get("freight.sysroot", null);
  if (savedSysroot === null && info.sysroot) {
    activeSysroot = info.sysroot;
    await context.workspaceState.update("freight.sysroot", activeSysroot);
    refreshStatusBars("idle");
  }
}

async function stopLanguageServer() {
  if (!client) return;
  const old = client;
  client = undefined;
  await old.stop();
  docIndexCount = 0;
  renderDocIndexBar();
  refreshStatusBars("idle");
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
    { language: "freight-manifest",   scheme: "file" },
    { language: "c",                  scheme: "file" },
    { language: "cpp",                scheme: "file" },
    { language: "cuda-cpp",           scheme: "file" },
    { language: "objective-c",        scheme: "file" },
    { language: "objective-cpp",      scheme: "file" },
    { language: "fortran",            scheme: "file" },
    { language: "FortranFreeForm",    scheme: "file" },
    { language: "FortranFixedForm",   scheme: "file" },
    { language: "asm",                scheme: "file" },
    { language: "nasm",               scheme: "file" },
    { language: "gas",                scheme: "file" },
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
    folder, `freight ${args.join(" ")}`, "freight", execution, "$freight"
  );
  await vscode.tasks.executeTask(task);
}

// ── Task provider ─────────────────────────────────────────────────────────────

class FreightTaskProvider {
  provideTasks() {
    return (vscode.workspace.workspaceFolders || []).flatMap(freightTasks);
  }
  resolveTask(task) {
    const command = task.definition.command;
    const folder = task.scope?.uri ? task.scope : (vscode.workspace.workspaceFolders || [])[0];
    if (!folder || !command) return undefined;
    return makeFreightTask(folder, command, task.definition.args || []);
  }
}

// ── Debug provider ────────────────────────────────────────────────────────────

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
      profile: config.profile ?? activeProfile,
      release: config.release ?? activeProfile === "release",
      // Inject status bar values as defaults (explicit launch config overrides them)
      bin:     config.bin     ?? activeTarget  ?? undefined,
      sysroot: config.sysroot ?? activeSysroot ?? undefined,
      family:  config.family  ?? activeFamily  ?? undefined,
      cwd: resolveCwd(config.cwd, workspaceFolder),
      args: Array.isArray(config.args) ? config.args : [],
      stopAtBeginningOfMainSubprogram: config.stopAtBeginningOfMainSubprogram ?? config.stopAtEntry ?? undefined
    };
  }

  async provideDebugConfigurations() {
    const bins = explorerProvider?.getBinNames() ?? [];
    const configs = [
      { name: "Freight: Run",   type: "freight", request: "launch", mode: "run",   cwd: "${workspaceFolder}", args: [] },
      { name: "Freight: Debug", type: "freight", request: "launch", mode: "debug", cwd: "${workspaceFolder}", args: [] },
    ];
    for (const bin of bins) {
      configs.push({ name: `Freight: Debug ${bin}`, type: "freight", request: "launch", mode: "debug", bin, cwd: "${workspaceFolder}", args: [] });
    }
    return configs;
  }
}

// ── Debug adapter factory ─────────────────────────────────────────────────────

class FreightDebugAdapterFactory {
  async createDebugAdapterDescriptor(session) {
    const config = session.configuration;
    const freight = vscode.workspace.getConfiguration("freight").get("executablePath", "freight");
    const folder = getActiveWorkspaceFolder();
    // Resolve ${workspaceFolder} so the subprocess gets a real path.
    const cwd = folder ? resolveCwd(config.cwd, folder) : undefined;

    if (config.mode === "run") {
      if (folder) {
        const resolvedConfig = await resolveBin(config);
        if (!resolvedConfig) {
          // User cancelled — end the debug session cleanly.
          return new vscode.DebugAdapterInlineImplementation(new CancelledAdapter());
        }
        await runFreightCommand(buildRunArgs(resolvedConfig));
      }
      return new vscode.DebugAdapterInlineImplementation(new CancelledAdapter());
    }

    const resolvedConfig = await resolveBin(config);
    if (!resolvedConfig) {
      return new vscode.DebugAdapterInlineImplementation(new CancelledAdapter());
    }

    const dapArgs = ["dap"];
    if (resolvedConfig.request === "attach") dapArgs.push("--attach");
    const configPath = writeDapConfig(resolvedConfig);
    if (configPath) dapArgs.push("--config", configPath);

    return new vscode.DebugAdapterExecutable(freight, dapArgs, cwd ? { cwd } : undefined);
  }
}

/** Minimal inline DAP adapter that immediately sends an 'initialized' then
 *  terminates the session. Used to cleanly end sessions that were handled
 *  out-of-band (freight run via task) without leaving VS Code in a loading state. */
class CancelledAdapter {
  onError() {}
  onExit() {}
  handleMessage(message) {
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
  _sendResponse(req, body) {
    this._emit({ type: "response", request_seq: req.seq, seq: 0, success: true, command: req.command, body });
  }
  _sendEvent(event) {
    this._emit({ type: "event", seq: 0, event });
  }
  _emit(msg) {
    if (this._cb) this._cb(msg);
  }
  sendMessage() {}
  dispose() {}
  // VS Code calls setMessageCallback to receive messages from the adapter.
  setMessageCallback(cb) { this._cb = cb; }
}

// ── Launch config helpers ─────────────────────────────────────────────────────

async function resolveBin(config) {
  if (config.bin || config.request === "attach") return config;
  const bins = explorerProvider?.getBinNames() ?? [];
  if (bins.length <= 1) return config;
  const choice = await vscode.window.showQuickPick(
    bins.map((b) => ({ label: b })),
    { placeHolder: "Select binary to run" }
  );
  if (!choice) return null;
  return { ...config, bin: choice.label };
}

function buildRunArgs(config) {
  const args = ["run"];
  if (config.release) args.push("--release");
  if (config.package) args.push("-p", config.package);
  if (config.bin)     args.push("--bin", config.bin);
  if (Array.isArray(config.features) && config.features.length > 0) {
    args.push("--features", config.features.join(","));
  }
  if (config.noDefaultFeatures) args.push("--no-default-features");
  if (Array.isArray(config.args) && config.args.length > 0) {
    args.push("--", ...config.args);
  }
  return args;
}

function writeDapConfig(config) {
  const payload = dapConfigPayload(config);
  const file = path.join(os.tmpdir(), `freight-dap-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  setTimeout(() => fs.unlink(file, () => {}), 60_000).unref?.();
  return file;
}

function dapConfigPayload(config) {
  const payload = {
    request: config.request,
    profile: config.profile,
    release: config.release,
    package: config.package,
    bin: config.bin,
    features: Array.isArray(config.features) ? config.features : undefined,
    noDefaultFeatures: config.noDefaultFeatures,
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

function resolveCwd(cwd, folder) {
  if (!cwd || cwd === "${workspaceFolder}") return folder.uri.fsPath;
  return cwd.replace("${workspaceFolder}", folder.uri.fsPath);
}

// ── Task helpers ─────────────────────────────────────────────────────────────

function freightTasks(folder) {
  return [
    makeFreightTask(folder, "build", [],              vscode.TaskGroup.Build),
    makeFreightTask(folder, "build", ["--release"]),
    makeFreightTask(folder, "run",   []),
    makeFreightTask(folder, "test",  [],              vscode.TaskGroup.Test),
    makeFreightTask(folder, "fetch", []),
    makeFreightTask(folder, "clean", []),
    makeFreightTask(folder, "compile-commands", []),
  ];
}

function makeFreightTask(folder, command, args, group) {
  const config = vscode.workspace.getConfiguration("freight");
  const freight = config.get("executablePath", "freight");
  const label = `freight ${[command, ...args].join(" ")}`.trim();
  const execution = new vscode.ShellExecution(freight, [command, ...args], { cwd: folder.uri.fsPath });
  const task = new vscode.Task(
    { type: "freight", command, args }, folder, label, "freight", execution, "$freight"
  );
  if (group) task.group = group;
  return task;
}

module.exports = { activate, deactivate, _test: { dapConfigPayload } };
