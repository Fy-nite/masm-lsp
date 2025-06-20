/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------
 *  */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';

let client: LanguageClient;

async function findTMASFiles(workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined): Promise<string[]> {
	const results: string[] = [];
	if (!workspaceFolders) {return results;}
	for (const folder of workspaceFolders) {
		const folderPath = folder.uri.fsPath;
		const stack = [folderPath];
		while (stack.length) {
			const dir = stack.pop()!;
			const tmasPath = path.join(dir, 'MicroASM.tmas');
			if (fs.existsSync(tmasPath)) {
				results.push(tmasPath);
			}
			// Search subfolders (shallow, or add depth limit if desired)
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name[0] !== '.') {
					stack.push(path.join(dir, entry.name));
				}
			}
		}
	}
	return results;
}

export function activate(context: vscode.ExtensionContext) {
	// The server is implemented in node
	const serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'server.js')
	);

	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc
		}
	};

	// Retrieve the toolchainPath from the workspace configuration
	const toolchainPath = vscode.workspace.getConfiguration('microasm').get<string>('toolchainPath');

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'microasm' }],
		synchronize: {
			fileEvents: vscode.workspace.createFileSystemWatcher('**/.clientrc')
		},
		initializationOptions: {
			toolchainPath // Pass the toolchainPath to the server
		}
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('extension.selectMicroASMToolchain', async () => {
			const tmasFiles = await findTMASFiles(vscode.workspace.workspaceFolders);

			// Create QuickPick items, adding a "Clear" option at the beginning
			const quickPickItems: vscode.QuickPickItem[] = [
				{ label: '(Clear Toolchain Selection)', description: '$(trash) Clear the current toolchain setting' }
			];
			quickPickItems.push(...tmasFiles.map(f => ({ label: path.basename(path.dirname(f)), description: f })));

			if (tmasFiles.length === 0) {
				vscode.window.showWarningMessage('No MicroASM.tmas files found in workspace. You can still clear the setting.');
			}

			const picked = await vscode.window.showQuickPick(
				quickPickItems,
				{ placeHolder: 'Select MicroASM Toolchain (MicroASM.tmas) or Clear Selection' }
			);

			if (picked) {
				if (picked.label === '(Clear Toolchain Selection)') {
					await vscode.workspace.getConfiguration('microasm').update('toolchainPath', undefined, vscode.ConfigurationTarget.Workspace);
					vscode.window.showInformationMessage('MicroASM toolchain selection cleared.');
				} else {
					await vscode.workspace.getConfiguration('microasm').update('toolchainPath', picked.description, vscode.ConfigurationTarget.Workspace);
					vscode.window.showInformationMessage(`MicroASM toolchain set to: ${picked.description}`);
				}
			}
		})
	);

	client = new LanguageClient(
		'microasm',
		'MicroASM Language Server',
		serverOptions,
		clientOptions
	);

	console.log('Starting MicroASM Language Client...');
	client.start();
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
