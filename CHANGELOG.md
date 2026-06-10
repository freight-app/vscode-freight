# Changelog

## 0.2.0

- C/C++ document symbols, folding, references, document highlight, and semantic
  highlighting now flow through `freight lsp` (served by `clangd` by default).
- New experimental setting `freight.lsp.useClangBridge` (default off): route
  those C/C++ features to Freight's in-process clang bridge instead of clangd.
  Off while the bridge matures — `clangd` remains the reliable path.

## 0.1.0

- Initial release: `freight.toml` language support, `freight lsp` client, task
  provider, run/debug configurations, explorer panel, and status bar.
