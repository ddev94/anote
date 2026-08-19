import * as vscode from "vscode"

import type { Configs } from "./config"

/**
 * The notes MCP server, offered to the editor's own agent.
 *
 * `src/mcp/` is a program that reads a folder of `.note` files and speaks MCP
 * over a pipe. Anything that starts processes can use it, and the price of that
 * generality is paid at the edges: whatever starts it has to be told where the
 * notes are, and every client has its own place to write that down —
 * `~/.claude.json`, a `.mcp.json` per repo, a settings file. Registering it by
 * hand is a path, a scope and a rebuild to remember.
 *
 * This is the one client that does not have to be told any of it. The extension
 * is already running in the window whose folders those are, so it can hand the
 * editor a finished server definition per workspace folder — the right `cwd`,
 * the right path to the bundle it ships beside itself, and a version that changes
 * when it does. Installing the extension is the whole of the configuration.
 *
 * Two details that are easy to get wrong and silent when you do:
 *
 * - **`process.execPath` is the editor's own Node**, which is what lets this work
 *   on a machine with no `node` on the PATH. In a desktop window that binary is
 *   Electron, and Electron only behaves as Node with `ELECTRON_RUN_AS_NODE` set —
 *   without it the "server" is a second editor window that never answers. On a
 *   remote, in a container or in WSL the extension host is already Node and the
 *   variable is ignored, which is why it can simply always be set.
 * - **`.fsPath`, resolved on the extension host's side.** The server is spawned
 *   where this code is running, so both the bundle's path and the folder's are
 *   that machine's — which is what makes a note in a container reachable, and
 *   what a hard-coded local path would break.
 */
export function provideMcpServer(
  context: vscode.ExtensionContext,
  configs: Configs
): vscode.Disposable {
  /* The editor caches what the provider returned. Opening a second folder is a
     second notes server, and it does not exist until this says so — and so is a
     folder whose `anote.config.json` has just turned `mcp.enabled` on, or moved
     `notesDir` out from under a server that is already running. */
  const changed = new vscode.EventEmitter<void>()

  return vscode.Disposable.from(
    changed,
    vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire()),
    configs.onDidChange(() => changed.fire()),
    vscode.lm.registerMcpServerDefinitionProvider("anote.mcp", {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: () => serversFor(context, configs),
    })
  )
}

function serversFor(
  context: vscode.ExtensionContext,
  configs: Configs
): vscode.McpStdioServerDefinition[] {
  const folders = vscode.workspace.workspaceFolders ?? []
  const bundle = vscode.Uri.joinPath(context.extensionUri, "dist", "mcp.js")
  const version = String(context.extension.packageJSON.version ?? "0")

  return folders
    /* A folder that has said no. The whole server rather than a tool at a time:
       "these notes are not for the agent" is one decision, and half of it would
       be a worse answer than either. */
    .filter((folder) => configs.for(folder.uri).mcp.enabled)
    .map(
      (folder) =>
        new vscode.McpStdioServerDefinition(
          // Named after the folder only when there is more than one, because in
          // the ordinary window the name is a label on one thing and "ANote" is
          // what it is.
          folders.length > 1 ? `ANote — ${folder.name}` : "ANote",
          process.execPath,
          // `notesDir` and not the folder: the server is given the same root the
          // `New Note` command writes into, so what an agent can list is what a
          // person would have created.
          [bundle.fsPath, configs.notesRoot(folder).fsPath],
          {
            ELECTRON_RUN_AS_NODE: "1",
            // Where `anote.config.json` is, which is not where the notes are
            // once `notesDir` has been set — the server reads the same config
            // this side did rather than guessing by walking up from the notes.
            ANOTE_CONFIG_DIR: folder.uri.fsPath,
          },
          // Changing this is how the editor is told the tools may have moved, and
          // it is the extension's own version because that is what moves them.
          version
        )
    )
}
