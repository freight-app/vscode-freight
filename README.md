# Freight VS Code Extension

This extension wires VS Code to Freight projects.

## Features

- `freight.toml` language contribution and TextMate highlighting.
- `freight lsp` client for manifest diagnostics, completion, hover, signature
  help, and source LSP passthroughs.
- Freight task provider for build, run, test, fetch, clean, and compile commands.
- Run and Debug panel configurations for `freight run` and `freight debug`.
- Status bar entry with a quick compile database command.

## Requirements

- Freight on `PATH`, or set `freight.executablePath`.
- Bun for local development.
- Optional source language servers: `clangd`, `fortls`, and `asm-lsp`.

## Debugging

The extension contributes a `Freight` debug type with starter configurations:

- `Freight: Run` runs `freight run`.
- `Freight: Run Release` runs `freight run --release`.
- `Freight: Debug` runs `freight debug`.

Optional launch fields include `package`, `bin`, `args`, `features`,
`noDefaultFeatures`, `release`, and `debugger`.

## Development

```sh
bun install
bun run package
```

Open this folder in VS Code and press `F5` to launch an Extension Development
Host.

The extension expects a `freight` executable on `PATH` by default. Override
`freight.executablePath` if you want to use a local binary.
