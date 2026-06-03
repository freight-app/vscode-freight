# vscode-freight TODO

## Debug adapter

- [x] **Stop-on-entry option** — expose `stopAtEntry` in launch config; when set, add
  `stopAtBeginningOfMainSubprogram: true` to the launch args forwarded to GDB/LLDB so
  VS Code can step from the very first instruction.

- [x] **Program args passthrough** — `args` array in launch config should be appended to
  the `launch` arguments forwarded to GDB so the debuggee receives them.  Currently `args`
  is used for `freight run` but not plumbed into the DAP launch path.

- [x] **Environment variables** — add an `env` map to the launch config
  (`"env": {"FOO": "bar"}`) and forward it to the native adapter.

- [ ] **Pre-launch task** — honour `preLaunchTask` so users can run a custom build step
  before `freight dap` starts (freight already builds internally, but some projects
  need extra steps like code generation).

- [x] **Attach to process** — the `attach` request is wired in `freight dap` but the
  extension doesn't expose an attach configuration provider.  Add a `request: "attach"`
  config shape with `pid` and `processName` fields.

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
