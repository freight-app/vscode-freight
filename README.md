# Freight VS Code Extension

This extension wires VS Code to Freight projects.

## Features

- `freight.toml` language contribution and TextMate highlighting.
- `freight lsp` client for manifest diagnostics, completion, hover, signature
  help, and source LSP passthroughs.
- **C/C++ language support** through `freight lsp` — hover, go-to-definition,
  completion, signature help, document symbols, folding, references, highlight,
  and semantic highlighting. Served by `clangd` by default; an experimental
  in-process clang bridge can be enabled with `freight.lsp.useClangBridge`.
- Freight task provider for build, run, test, fetch, clean, and compile commands.
- Run and Debug panel configurations for Freight workflows.
- Status bar entry with a quick compile database command.

## Requirements

- Freight on `PATH`, or set `freight.executablePath`.
- Bun for local development.
- Optional source language servers: `clangd`, `fortls`, and `asm-lsp`.

## Debugging

The extension contributes a `Freight` debug type with starter configurations:

- `Freight: Run` shells out to `freight run` through a VS Code task.
- `Freight: Run Release` shells out to `freight run --release`.
- `Freight: Debug` starts `freight dap`, which builds the debug profile and
  execs into the native debugger adapter.
- `Freight: Attach` starts `freight dap --attach`, which skips the build and
  execs into the native debugger adapter.

Optional launch fields include `package`, `bin`, `args`, `features`,
`noDefaultFeatures`, `release`, `debugger`, `debuggerPath`, `debuggerArgs`,
`stopAtEntry`, and `env`. `Freight: Run` uses the run-related fields directly.
`Freight: Debug` and `Freight: Attach` write the resolved launch settings to a
temporary JSON file and start `freight dap --config <file>` so Freight can
select the package, binary, feature set, profile, and debugger before it execs
the native adapter.

Native debugger adapter process args are merged in this order:
`freight dap` defaults, `[debugger.<name>].args` from `~/.freight/config.toml`
and `<workspace>/.freight/config.toml`, then launch.json `debuggerArgs`.

Debugging depends on the native adapter selected by Freight. Install GDB with
DAP support (`gdb --interpreter=dap`) or `lldb-dap` / `lldb-vscode`.

## Development

```sh
bun install
bun run test
bun run package
```

Open this folder in VS Code and press `F5` to launch an Extension Development
Host. If you open the full freight workspace instead, use the
`VS Code Freight: Extension` launch configuration from the workspace root.

The extension expects a `freight` executable on `PATH` by default. Override
`freight.executablePath` if you want to use a local binary.
