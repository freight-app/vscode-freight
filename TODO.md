# vscode-freight TODO

## Debug adapter

- [x] **Resync with simplified `freight dap`** — `freight dap` now builds and
  `exec()`s directly into GDB/LLDB. The extension now writes the resolved launch
  config to a temp JSON file and starts `freight dap --config <file>` so
  Freight sees build/debugger fields before selecting the native adapter.

- [x] **Choose config transport for debug launches** — either add stable
  `freight dap` CLI flags / a config file for build and debugger selection.
  Implemented as `freight dap --config <json>`.

- [x] **Stop-on-entry option** — expose `stopAtEntry` in launch config and make
  sure it reaches the native adapter as the correct backend-specific launch
  field (`stopAtBeginningOfMainSubprogram` for GDB/LLDB where applicable).

- [x] **Program args passthrough** — `args` array in launch config should reach
  the native adapter launch request so the debuggee receives them.

- [x] **Environment variables** — `env` is present in the schema and reaches the
  native adapter launch request.

- [ ] **Pre-launch task** — honour `preLaunchTask` so users can run a custom build step
  before `freight dap` starts (freight already builds internally, but some projects
  need extra steps like code generation).

- [x] **Attach debugger selection** — attach starts `freight dap --attach`, but
  `debugger` / `debuggerPath` from the VS Code attach config reach Freight via
  `--config` before it selects the native adapter.

- [ ] **Real VS Code debug smoke test** — verify launch and attach in an
  Extension Development Host against a tiny Freight project with GDB DAP and/or
  `lldb-dap`: breakpoints, continue, step, stack, locals, args, env, and exit.
  Unit coverage now checks VS Code config serialization and Freight-side
  adapter selection for fake GDB, CUDA-GDB, and LLDB DAP adapters, including
  config.toml debugger args plus launch.json `debuggerArgs`.

- [ ] **Additional DAP backends** — once Freight core grows DAP-capable adapters
  for the remaining debugger templates, expose and smoke test them here:
  `rr` replay workflows, Windows `cdb`, and Windows `windbg`. GDB, CUDA-GDB,
  and LLDB DAP are the supported editor-debug backends for now.

- [x] **Multi-binary workspaces** — when `bin` is not set and multiple `[[bin]]` targets exist, a quick-pick prompts for selection before launch/run.

## Language server (freight lsp)

- [ ] **Completion for dep versions** — query the local registry msgpack cache to suggest
  known versions when the user types `libfoo = "`.

- [ ] **Inlay hints** — show latest available version alongside each dependency entry
  (`# latest: 1.4.2`).

- [ ] **Code action: update to latest** — "Update version constraint to ^1.4.2" code
  action on each dep, resolved from the registry cache.

- [ ] **Go-to-definition for path deps** — `path = "../libfoo"` should open that
  project's `freight.toml`.  Scaffolded but not yet wired to the LSP client.

- [ ] **Diagnostics for unknown keys** — warn on unrecognised `freight.toml` keys
  (e.g. typos in `[compiler]`).

## Explorer panel

- [x] **Wire up the explorer view** — registered tree view, view shows when `freight.toml` is present.

- [x] **Refresh on save** — `FreightExplorerProvider` sets up a `FileSystemWatcher` on `freight.toml`; calls `refresh()` on change/create/delete.

- [x] **Run/debug from explorer** — inline `$(run)` and `$(debug-alt)` buttons on `[[bin]]` nodes; clicking the node itself launches debug.

## Status bar

- [x] **Show current profile** — status bar shows `[release]` suffix when release is active; clicking opens a quick-pick to switch; persisted in workspace state.

- [x] **Last build result** — shows `$(check)` / `$(error)` / `$(sync~spin)` based on task exit code; updates on task start/end.

- [ ] **Active debugger** — show which debugger (`gdb`/`lldb`) freight resolved so the
  user knows what's running.

## Packaging / distribution

- [ ] **Bundle with `vsce package`** — verify `bun run package` produces a clean `.vsix`
  with no missing activation events or broken paths.

- [ ] **Marketplace publish** — set up a CI step (`vsce publish`) triggered on version
  tags; bump `version` in `package.json` and add a `CHANGELOG.md` first.

- [ ] **Extension icon** — add a `icon.png` (128×128) to `package.json`'s `"icon"` field.
