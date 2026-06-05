type CompilerFamily = "gcc" | "clang" | "msvc" | "nvcc";

// Shared mutable extension state. It is intentionally small and UI-oriented;
// persisted values still live in VS Code workspaceState or freight.toml.
interface FamilyOption {
  label: "auto" | CompilerFamily;
  description: string;
}

interface ExtensionState {
  activeProfile: string;
  activeTarget: string | null;
  activeSysroot: string | null;
  activeFamily: CompilerFamily | null;
  detectedFamilies: string[] | null;
  explorerProvider: any;
}

const ALL_FAMILIES: FamilyOption[] = [
  { label: "auto", description: "Let freight detect the compiler" },
  { label: "gcc", description: "GCC / g++ / gfortran" },
  { label: "clang", description: "Clang / clang++ / clang-cl" },
  { label: "msvc", description: "MSVC (cl.exe)" },
  { label: "nvcc", description: "NVIDIA CUDA compiler" },
];

function createState(context: any): ExtensionState {
  return {
    activeProfile: context.workspaceState.get("freight.profile", "dev"),
    activeTarget: context.workspaceState.get("freight.target", null),
    activeSysroot: context.workspaceState.get("freight.sysroot", null),
    activeFamily: context.workspaceState.get("freight.family", null),
    detectedFamilies: null,
    explorerProvider: null,
  };
}

export {
  ALL_FAMILIES,
  createState,
};

export type { CompilerFamily, ExtensionState, FamilyOption };
