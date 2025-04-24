# MicroASM Language Server Example

A sample language server for the MicroASM language.


not everything you see here is complete.
lsp is hard to develop for, have you read the spec?
that's like 100 pages of pure lsp spec that doesnt even make sense because it's typescript constants.


## Functionality

This Language Server works for MicroASM files (`.masm`, `.mas`). It has the following language features:
- **Completions:** Suggests known instructions, registers, defined labels (`#label`), and defined memory addresses (`$address`).
- **Diagnostics:** Detects issues like:
    - Unknown instructions (with suggestions based on Levenshtein distance).
    - Incorrect argument counts for instructions.
    - Invalid label/address formats.
    - Undefined label references (with suggestions).
    - Redefined labels/addresses within the same file.
    - Include file resolution errors (not found, circular includes).
- **Quick Fixes:** Offers code actions to automatically correct misspelled instructions or labels based on suggestions.
- **Include File Support:** Parses `#include "filename"` directives, searching first in a configured `microasm.includePath` setting and then relative to the current file.
- **Configuration:** Supports settings for `microasm.maxNumberOfProblems` and `microasm.includePath`.

It also includes an End-to-End test setup (though the tests themselves may need updating for MicroASM).

## Structure

```
.
├── client // Language Client
│   ├── src
│   │   ├── test // End to End tests for Language Client / Server
│   │   └── extension.ts // Language Client entry point
├── package.json // The extension manifest.
└── server // Language Server
    └── src
        └── server.ts // Language Server entry point
```

## Running the Sample

- Run `npm install` in this folder. This installs all necessary npm modules in both the client and server folder
- Open VS Code on this folder.
- Press Ctrl+Shift+B to start compiling the client and server in [watch mode](https://code.visualstudio.com/docs/editor/tasks#:~:text=The%20first%20entry%20executes,the%20HelloWorld.js%20file.).
- Switch to the Run and Debug View in the Sidebar (Ctrl+Shift+D).
- Select `Launch Client` from the drop down (if it is not already).
- Press ▷ to run the launch config (F5).
- In the [Extension Development Host](https://code.visualstudio.com/api/get-started/your-first-extension#:~:text=Then%2C%20inside%20the%20editor%2C%20press%20F5.%20This%20will%20compile%20and%20run%20the%20extension%20in%20a%20new%20Extension%20Development%20Host%20window.) instance of VSCode, create or open a file with a `.masm` or `.uasm` extension.
  - Start typing an instruction like `MO` or `AD` to see instruction completions.
  - After an instruction like `MOV`, press space and start typing `R` to see register completions.
  - Define a label: `LBL my_label`. Then type `JMP #my` to see label completion.
  - Define data: `DB $100 "Data"`. Then type `MOV RAX $1` to see address completion.
  - Type an incorrect instruction like `MOOV`. A diagnostic error should appear with a suggestion and a quick fix (lightbulb).
  - Create an include file (e.g., `utils.masm`) and use `#include "utils.masm"` in your main file. Test include path resolution with and without the `microasm.includePath` setting.

## Packaging the Extension

To create a `.vsix` file that can be installed in VS Code:

1.  **Install vsce:** If you don't have it, install the VS Code Extension command-line tool:
    ```bash
    npm install -g @vscode/vsce
    ```
2.  **Ensure Prerequisites:** Make sure you have run `npm install` in the root directory.
    This installs all necessary npm modules in both the client and server folder.
3.  **Package:** Run the following command in the root directory (`lsp-sample`):
    ```bash
    vsce package
    ```
    This will create a `.vsix` file (e.g., `microasm-lsp-X.Y.Z.vsix`) in the project root. You can then install this file in VS Code via the Extensions view (`...` > `Install from VSIX...`).
