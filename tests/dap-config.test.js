const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return {
      TreeItem: class {},
      TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
      ThemeIcon: class {
        constructor(id) {
          this.id = id;
        }
      },
      EventEmitter: class {
        constructor() {
          this.event = () => {};
        }
        fire() {}
        dispose() {}
      },
      window: { activeTextEditor: null },
    };
  }
  if (request === "vscode-languageclient/node") return { LanguageClient: class {} };
  return originalLoad.call(this, request, parent, isMain);
};

const extensionEntry = process.env.FREIGHT_EXTENSION_TEST_ENTRY || "../dist/extension.js";
const { _test } = require(extensionEntry);

const payload = _test.dapConfigPayload({
  request: "launch",
  profile: "release",
  release: true,
  package: "app",
  bin: "demo",
  features: ["ssl", "zlib"],
  noDefaultFeatures: true,
  debugger: "gdb",
  debuggerPath: "/usr/bin/gdb",
  debuggerArgs: ["--adapter-log", "/tmp/gdb-dap.log"],
  noBuild: true,
  cwd: "/tmp/project",
  env: { FREIGHT_TEST: "1" },
  args: ["--case", "smoke"],
  stopAtEntry: true,
});

assert.deepStrictEqual(payload, {
  request: "launch",
  profile: "release",
  release: true,
  package: "app",
  bin: "demo",
  features: ["ssl", "zlib"],
  noDefaultFeatures: true,
  debugger: "gdb",
  debuggerPath: "/usr/bin/gdb",
  debuggerArgs: ["--adapter-log", "/tmp/gdb-dap.log"],
  noBuild: true,
  cwd: "/tmp/project",
  env: { FREIGHT_TEST: "1" },
  args: ["--case", "smoke"],
  stopAtEntry: true,
  stopAtBeginningOfMainSubprogram: true,
});

const attach = _test.dapConfigPayload({
  request: "attach",
  debugger: "lldb",
  debuggerPath: "lldb-dap",
  debuggerArgs: "not-an-array",
  args: "not-an-array",
  features: "not-an-array",
});

assert.deepStrictEqual(attach, {
  request: "attach",
  debugger: "lldb",
  debuggerPath: "lldb-dap",
});

const parsedGcc = _test.parseExecutionOutput(
  "src/main.cpp:4:10: fatal error: vecmath/vec.hpp: No such file or directory\n",
  "/tmp/project"
);
assert.deepStrictEqual(parsedGcc, [{
  file: "/tmp/project/src/main.cpp",
  line: 4,
  character: 10,
  severity: "error",
  message: "vecmath/vec.hpp: No such file or directory",
}]);

const parsedFreightSummary = _test.parseExecutionOutput(
  "error: build failed\n  src/main.cpp:7:3 expected ';' after expression\n",
  "/tmp/project"
);
assert.deepStrictEqual(parsedFreightSummary, [{
  file: "/tmp/project/src/main.cpp",
  line: 7,
  character: 3,
  severity: "error",
  message: "expected ';' after expression",
}]);

const parsedMsvc = _test.parseExecutionOutput(
  "src\\main.cpp(12,5): error C2143: syntax error: missing ';' before '}'\n",
  "C:\\project"
);
assert.deepStrictEqual(parsedMsvc, [{
  file: pathLike("C:\\project", "src\\main.cpp"),
  line: 12,
  character: 5,
  severity: "error",
  message: "syntax error: missing ';' before '}'",
}]);

const runtimeFallback = _test.fallbackExecutionFailures(
  ["run"],
  "/tmp/project",
  1,
  null,
  "starting\nSegmentation fault\n"
);
assert.deepStrictEqual(runtimeFallback, [{
  file: "/tmp/project/freight.toml",
  line: 1,
  character: 1,
  severity: "error",
  message: "freight run exited with code 1: Segmentation fault",
}]);

const cppTerminateOutput = [
  "terminate called after throwing an instance of 'std::runtime_error'",
  "  what():  bad input",
  "Aborted (core dumped)",
].join("\n");
assert.strictEqual(
  _test.cppTerminateMessage(cppTerminateOutput),
  "Unhandled C++ exception std::runtime_error: bad input"
);
assert.strictEqual(
  _test.runtimeFailurePopupMessage(["run"], 134, null, cppTerminateOutput),
  "Unhandled C++ exception std::runtime_error: bad input"
);
assert.strictEqual(
  _test.runtimeFailurePopupMessage(["run"], 0, null, cppTerminateOutput),
  "Unhandled C++ exception std::runtime_error: bad input"
);
assert.strictEqual(
  _test.runtimeFailurePopupMessage(["build"], 1, null, cppTerminateOutput),
  null
);
assert.strictEqual(
  _test.debugRuntimePopupMessage({ mode: "debug" }, cppTerminateOutput),
  "Unhandled C++ exception std::runtime_error: bad input"
);
assert.strictEqual(
  _test.debugRuntimePopupMessage({ mode: "run" }, cppTerminateOutput),
  null
);

const cppRuntimeFallback = _test.fallbackExecutionFailures(
  ["run"],
  "/tmp/project",
  134,
  null,
  cppTerminateOutput
);
assert.deepStrictEqual(cppRuntimeFallback, [{
  file: "/tmp/project/freight.toml",
  line: 1,
  character: 1,
  severity: "error",
  message: "freight run exited with code 134: Unhandled C++ exception std::runtime_error: bad input",
}]);

const cppRuntimeFallbackWithZeroExit = _test.fallbackExecutionFailures(
  ["run"],
  "/tmp/project",
  0,
  null,
  cppTerminateOutput
);
assert.deepStrictEqual(cppRuntimeFallbackWithZeroExit, [{
  file: "/tmp/project/freight.toml",
  line: 1,
  character: 1,
  severity: "error",
  message: "freight run runtime error: Unhandled C++ exception std::runtime_error: bad input",
}]);

function pathLike(root, child) {
  return require("path").resolve(root, child);
}

console.log("vscode-freight dap config tests ok");
