# Freight VS Code Extension

This extension wires VS Code to Freight projects.

## Features

- `freight.toml` language contribution and TextMate highlighting.
- `freight lsp` client for manifest diagnostics, completion, hover, signature
  help, and source LSP passthroughs.
- Freight task provider for build, run, test, fetch, clean, and compile commands.
- Run and Debug panel configurations backed by `freight dap`.
- Status bar entry with a quick compile database command.

## Requirements

- Freight on `PATH`, or set `freight.executablePath`.
- Bun for local development.
- Optional source language servers: `clangd`, `fortls`, and `asm-lsp`.

## Debugging

The extension contributes a `Freight` debug type with starter configurations:

- `Freight: Run` runs through Freight's DAP adapter.
- `Freight: Run Release` runs through Freight's DAP adapter with `release`.
- `Freight: Debug` builds the debug profile and launches Freight's DAP debugger.

Optional launch fields include `package`, `bin`, `args`, `features`,
`noDefaultFeatures`, `release`, and `debugger`. When `debugger` is omitted,
Freight reads `default_debugger` from `~/.freight/config.toml` and
`<workspace>/.freight/config.toml`.

The adapter supports breakpoints, stepping, stack frames, local variables, hover
evaluation, and watch expressions through Freight's backend.

## Development

```sh
bun install
bun run package
```

Open this folder in VS Code and press `F5` to launch an Extension Development
Host. If you open the full freight workspace instead, use the
`VS Code Freight: Extension` launch configuration from the workspace root.

The extension expects a `freight` executable on `PATH` by default. Override
`freight.executablePath` if you want to use a local binary.
