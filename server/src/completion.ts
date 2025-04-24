import {
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

// Export your completion handler as a function
export async function provideCompletion(
	textDocumentPosition: TextDocumentPositionParams,
	documents: any,
	knownInstructions: Set<string>,
	knownRegisters: Set<string>,
	jumpInstructions: Set<string>,
	getDocumentSettings: any,
	defaultSettings: any,
	getParsedDocInfo: any
): Promise<CompletionItem[]> {
	const document = documents.get(textDocumentPosition.textDocument.uri);
	if (!document) {return [];}
	// Use document.getText(...) from here on
	const position = textDocumentPosition.position;
			// Get the text on the line up to the cursor
			const linePrefix = document.getText({ start: { line: position.line, character: 0 }, end: position });
			// Find the start of the current word/token the cursor is in or immediately after
			const wordMatch = linePrefix.match(/[\w$#]+$/); // Match alphanumeric, $, or # at the end
			const currentWord = wordMatch ? wordMatch[0] : '';
	
			// Get the full line text to determine the instruction context
			const lineText = document.getText({ start: { line: position.line, character: 0 }, end: { line: position.line, character: Infinity } });
			const lineTrimmed = lineText.trimStart();
			const tokens = lineTrimmed.split(/\s+/);
			const instruction = tokens.length > 0 ? tokens[0].toUpperCase() : '';
	
			// Fetch settings with fallback before accessing includePath
			const settings = await getDocumentSettings(documents.uri) ?? defaultSettings;
			const docInfo = await getParsedDocInfo(documents, settings.includePath); // Get labels/DB info using guaranteed settings
	
			const items: CompletionItem[] = [];
	
			// Determine context
			if (tokens.length <= 1 && !lineTrimmed.includes(" ") && !currentWord.startsWith('$') && !currentWord.startsWith('#')) {
				// Typing the instruction (first word), unless it looks like an address or label start
				for (const instr of knownInstructions) {
					if (instr.startsWith(currentWord.toUpperCase())) { // Filter based on current word
						items.push({
							label: instr,
							kind: CompletionItemKind.Keyword,
							data: instr
						});
					}
				}
			} else {
				// Typing arguments or potentially completing instruction if space is typed
				const isTypingArgument = linePrefix.includes(" "); // Simple check if there's a space after the instruction
	
				if (isTypingArgument) {
					// Suggest Registers if the current word doesn't start with # or $
					if (!currentWord.startsWith('#') && !currentWord.startsWith('$')) {
						for (const reg of knownRegisters) {
							if (reg.startsWith(currentWord.toUpperCase())) { // Filter based on current word
								items.push({
									label: reg,
									kind: CompletionItemKind.Variable,
									data: reg
								});
							}
						}
					}
	
					// Suggest Labels if applicable and current word starts with #
					if (currentWord.startsWith('#') && (jumpInstructions.has(instruction) || instruction === 'CALL')) {
						const currentLabelPrefix = currentWord.substring(1);
						for (const [labelName] of docInfo.labels) {
							if (labelName.startsWith(currentLabelPrefix)) { // Filter based on current word (after #)
								items.push({
									label: `#${labelName}`,
									kind: CompletionItemKind.Reference,
									data: `#${labelName}`
								});
							}
						}
					}
	
					// Suggest DB Addresses if applicable and current word starts with $
					if (currentWord.startsWith('$') && ['OUT', 'IN', 'MOV', 'CMP', 'PUSH', 'CALL', 'MOVADDR', 'MOVTO', 'COPY', 'FILL', 'CMP_MEM', 'DB'].includes(instruction)) { // Added DB
						for (const [dbAddr] of docInfo.dbAddresses) {
							if (dbAddr.startsWith(currentWord)) { // Filter based on current word (including $)
								items.push({
									label: dbAddr,
									kind: CompletionItemKind.Value,
									data: dbAddr
								});
							}
						}
					}
	
					// Suggest immediate value '0' if starting to type a number (optional)
					// if (/^[0-9]/.test(currentWord)) {
					// 	items.push({ label: '0', kind: CompletionItemKind.Value, insertText: '0' });
					// }
				} else if (!linePrefix.includes(" ")) {
					// Still potentially typing the instruction, filter based on current word
					for (const instr of knownInstructions) {
						if (instr.startsWith(currentWord.toUpperCase())) {
							items.push({
								label: instr,
								kind: CompletionItemKind.Keyword,
								data: instr
							});
						}
					}
				}
			}
	
			return items;
		
}
