import * as vscode from "vscode";

// Small shared helpers only. Feature-specific behavior belongs in its own
// module so extension.ts stays a readable activation map.
function getActiveWorkspaceFolder() {
  const active = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
  if (active) return vscode.workspace.getWorkspaceFolder(active);
  return (vscode.workspace.workspaceFolders || [])[0];
}

function appendIfChanged(args: string[], flag: string, value: unknown, defaultValue: string) {
  if (typeof value === "string" && value && value !== defaultValue) args.push(flag, value);
}

function resolveCwd(cwd: string | undefined, folder: vscode.WorkspaceFolder) {
  if (!cwd || cwd === "${workspaceFolder}") return folder.uri.fsPath;
  return cwd.replace("${workspaceFolder}", folder.uri.fsPath);
}

function freightDocumentSelector() {
  const sourcePatterns = [
    "**/*.{c,h,cc,hh,cpp,hpp,cxx,hxx,c++,h++,cppm,ixx,mpp}",
    "**/*.{cu,cuh,hip,cl,ispc,m,mm}",
    "**/*.{f,for,ftn,f77,f66,f90,f95,f03,f08,f18}",
    "**/*.{F,FOR,FTN,F77,F66,F90,F95,F03,F08,F18}",
    "**/*.{asm,nasm,s,S}",
  ];
  return [
    { language: "freight-manifest", scheme: "file" },
    { language: "c", scheme: "file" },
    { language: "cpp", scheme: "file" },
    { language: "cuda-cpp", scheme: "file" },
    { language: "objective-c", scheme: "file" },
    { language: "objective-cpp", scheme: "file" },
    { language: "fortran", scheme: "file" },
    { language: "FortranFreeForm", scheme: "file" },
    { language: "FortranFixedForm", scheme: "file" },
    { language: "asm", scheme: "file" },
    { language: "nasm", scheme: "file" },
    { language: "gas", scheme: "file" },
    ...sourcePatterns.map((pattern) => ({ scheme: "file", pattern })),
  ];
}

function stripAnsi(text: unknown) {
  return String(text || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function truncate(text: unknown, max: number) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

export {
  appendIfChanged,
  freightDocumentSelector,
  getActiveWorkspaceFolder,
  resolveCwd,
  stripAnsi,
  truncate,
};
