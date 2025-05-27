import { Diagnostic, DiagnosticSeverity, TextDocument } from 'vscode-languageserver';
import type { MNISpecMap } from './mniSpec';
import * as fs from 'fs';
import * as path from 'path';

export async function validateTextDocument(
	textDocument: TextDocument,
	getDocumentSettings: (uri: string) => Promise<any>,
	defaultSettings: any,
	getParsedDocInfo: (doc: TextDocument, includePath: string | undefined) => Promise<any>,
	includeRegex: RegExp,
	memoryAddressRegex: RegExp,
	isValidMemoryAddress: (address: string) => boolean, // Add the new validation function
	knownInstructions: Set<string>,
	instructionArgCounts: Record<string, { min: number, max: number }>,
	registerRegex: RegExp,
	knownRegisters: Set<string>,
	labelRegex: RegExp,
	jumpInstructions: Set<string>,
	findClosestMatch: (input: string, options: Iterable<string>, maxDistance?: number) => string | null,
	mniSpecMap: MNISpecMap,
	toolchainPath: string | undefined // Pass toolchainPath as an argument
): Promise<Diagnostic[]> {
	// Use default settings as a fallback if settings resolve to null/undefined
	const settings = await getDocumentSettings(textDocument.uri) ?? defaultSettings;
	let configuredIncludePath = settings.includePath; // Get configured path

	// Check if a toolchainPath is provided and read its includePath
	if (toolchainPath && fs.existsSync(toolchainPath)) {
		try {
			const tmasContent = JSON.parse(fs.readFileSync(toolchainPath, 'utf-8'));
			if (tmasContent.includePath) {
				configuredIncludePath = path.resolve(path.dirname(toolchainPath), tmasContent.includePath);
			}
		} catch (error: any) {
			console.error(`Failed to read or parse MicroASM.tmas file: ${error.message}`);
		}
	}

	const text = textDocument.getText();
	const lines = text.split(/\r?\n/g);
	const diagnostics: Diagnostic[] = [];
	let problems = 0;

	// --- Get Combined Symbols and Include Errors ---
	// Pass the configured include path to the parser
	const parsedInfo = await getParsedDocInfo(textDocument, configuredIncludePath);
	const allLabels = parsedInfo.labels;
	const allDbAddresses = parsedInfo.dbAddresses;
	diagnostics.push(...parsedInfo.includeErrors); // Add errors found during include parsing
	problems += parsedInfo.includeErrors.length;

	const referencedLabels = new Set<string>();
	const referencedDbAddresses = new Set<string>();

	let unreachable = false; // Track unreachable code after HLT/JMP/EXIT
	let unreachableStartLine: number | null = null;
	let unreachableStartInstr: string | null = null;

	// Helper function to strip comments from a line
	function stripComment(line: string): string {
		const commentIndex = line.indexOf(';');
		return commentIndex !== -1 ? line.substring(0, commentIndex).trim() : line;
	}

	// --- Validate instructions, arguments, and references using combined symbols ---
	for (let i = 0; i < lines.length && problems < settings.maxNumberOfProblems; i++) {
		const line = lines[i].trim();
		if (line.length === 0 || line.startsWith(';') || includeRegex.test(line)) {
			continue;
		}

		// --- Unreachable code detection ---
		if (unreachable && line.length > 0 && !line.startsWith(';')) {
			problems++;
			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				range: { start: { line: i, character: 0 }, end: { line: i, character: line.length } },
				message: `Unreachable code detected after '${unreachableStartInstr}' on line ${unreachableStartLine! + 1}.`,
				source: 'microasm-ls'
			});
			// Do not reset unreachable here; keep flag set until a label or blank line is encountered
		}

		// --- Pass 1 Logic (Redefinitions, Format) ---
		const codeLineForPass1 = stripComment(line);
		const tokensForPass1 = codeLineForPass1.split(/\s+/).filter(token => token.length > 0);
		if (tokensForPass1.length === 0) continue; // Skip if no tokens after comment removal
		const instructionForPass1 = tokensForPass1[0].toUpperCase();
		const instructionStartIndexForPass1 = lines[i].indexOf(tokensForPass1[0]);

		if (instructionForPass1 === 'LBL') {
			if (tokensForPass1.length === 2) {
				const labelName = tokensForPass1[1];
				const definition = allLabels.get(labelName);
				if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(labelName)) {
					// Invalid format (Error)
					problems++;
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						range: { start: { line: i, character: lines[i].indexOf(labelName) }, end: { line: i, character: lines[i].indexOf(labelName) + labelName.length } },
						message: `Invalid label name format: ${labelName}`, source: 'microasm-ls'
					});
				} else if (definition && definition.uri === textDocument.uri && definition.line !== i) {
					// Redefined in *this* file (Warning) - check if definition URI matches current doc
					// Note: This doesn't warn if redefined across files, only within the same file.
					// Cross-file redefinition warnings would require more complex tracking.
					problems++;
					diagnostics.push({
						severity: DiagnosticSeverity.Warning,
						range: { start: { line: i, character: lines[i].indexOf(labelName) }, end: { line: i, character: lines[i].indexOf(labelName) + labelName.length } },
						message: `Label redefined in this file: ${labelName}. First defined on line ${definition.line + 1}`, source: 'microasm-ls'
					});
				}
			}
		} else if (instructionForPass1 === 'DB') {
			if (tokensForPass1.length >= 3) {
				const addressArg = tokensForPass1[1];
				const stringPartIndex = lines[i].indexOf(tokensForPass1[2], instructionStartIndexForPass1 + tokensForPass1[0].length + 1 + tokensForPass1[1].length);
				const stringLiteral = lines[i].substring(stringPartIndex).trim();
				const definition = allDbAddresses.get(addressArg);

				if (!isValidMemoryAddress(addressArg)) {
					// Invalid format (Error)
					problems++;
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						range: { start: { line: i, character: lines[i].indexOf(addressArg) }, end: { line: i, character: lines[i].indexOf(addressArg) + addressArg.length } },
						message: `Invalid DB address format: ${addressArg}. Expected $number or $[expression].`, source: 'microasm-ls'
					});
				} else if (!stringLiteral.startsWith('"') || !stringLiteral.endsWith('"')) {
					// Invalid string format (Error)
					problems++;
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						range: { start: { line: i, character: stringPartIndex }, end: { line: i, character: lines[i].length } },
						message: `Invalid DB string format. Expected "string".`, source: 'microasm-ls'
					});
				} else if (definition && definition.uri === textDocument.uri && definition.line !== i) {
					// Redefined in *this* file (Warning)
					problems++;
					diagnostics.push({
						severity: DiagnosticSeverity.Warning,
						range: { start: { line: i, character: lines[i].indexOf(addressArg) }, end: { line: i, character: lines[i].indexOf(addressArg) + addressArg.length } },
						message: `DB address redefined in this file: ${addressArg}. First defined on line ${definition.line + 1}`, source: 'microasm-ls'
					});
				}
			}
		}
		// --- End Pass 1 Logic (for current file) ---


		// --- Pass 2 Logic (References, Types, Counts) ---
		const codeLine = stripComment(line);
		const tokens = codeLine.split(/\s+/).filter(token => token.length > 0);
		if (tokens.length === 0) continue; // Skip if no tokens after comment removal
		
		if (tokens[0].toUpperCase() === 'DB' && tokens.length >= 3) {
			const stringPartIndex = lines[i].indexOf(tokens[2], lines[i].indexOf(tokens[0]) + tokens[0].length + 1 + tokens[1].length);
			const stringLiteral = lines[i].substring(stringPartIndex).trim();
			tokens.splice(2, tokens.length - 2, stringLiteral);
		}
		const instruction = tokens[0].toUpperCase();
		const args = tokens.slice(1);

		// --- Reset unreachable on label definition (labels are valid jump targets) ---
		if (instruction === 'LBL') {
			unreachable = false;
			unreachableStartLine = null;
			unreachableStartInstr = null;
		}

		// 1. Check unknown instructions
		if (!knownInstructions.has(instruction)) {
			problems++;
			let message = `Unknown instruction: ${tokens[0]}`;
			let detail = `Valid instructions include: MOV, ADD, SUB, JMP, etc.`;
			
			const suggestion = findClosestMatch(tokens[0], knownInstructions);
			const data: { suggestion?: string } = {};
			if (suggestion) {
				message += `. Did you mean '${suggestion}'?`;
				data.suggestion = suggestion;
				detail = `Example: ${getInstructionExample(suggestion)}`;
			}
			
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: { start: { line: i, character: lines[i].indexOf(tokens[0]) }, end: { line: i, character: lines[i].indexOf(tokens[0]) + tokens[0].length } },
				message: message,
				source: 'microasm-ls',
				data: data,
				relatedInformation: [{
					location: { uri: textDocument.uri, range: { start: { line: i, character: 0 }, end: { line: i, character: 0 } } },
					message: detail
				}]
			});
			continue;
		}

		// 2. Check argument count
		const countInfo = instructionArgCounts[instruction];
		if (countInfo) {
			const argCount = args.length;
			let isValidCount = false;
			if (countInfo.max === -1) { // Variable args
				isValidCount = argCount >= countInfo.min;
			} else {
				isValidCount = argCount >= countInfo.min && argCount <= countInfo.max;
			}

			if (!isValidCount) {
				problems++;
				let expected = `${countInfo.min}`;
				if (countInfo.max !== countInfo.min) {
					expected += (countInfo.max === -1) ? '+' : `-${countInfo.max}`;
				}
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range: { start: { line: i, character: lines[i].indexOf(tokens[0]) }, end: { line: i, character: lines[i].length } }, // Highlight whole line
					message: `${instruction} expects ${expected} arguments, but got ${argCount}.`, source: 'microasm-ls'
				});
				// Don't continue here, argument type checks might still be useful
			}
		}

		// --- Type checking for POP (should be a register), and optionally others ---
		if (instruction === 'POP' && args.length === 1) {
			const arg = args[0];
			const argStartIndex = lines[i].indexOf(arg, lines[i].indexOf(tokens[0]) + tokens[0].length);
			if (!registerRegex.test(arg)) {
				problems++;
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range: { start: { line: i, character: argStartIndex }, end: { line: i, character: argStartIndex + arg.length } },
					message: `POP expects a register as its argument, but got '${arg}'.`,
					source: 'microasm-ls'
				});
			}
		}
		// Add similar checks for other instructions as needed

		// 3. Check argument types and references (using allLabels, allDbAddresses)
		for (let j = 0; j < args.length; j++) {
			const arg = args[j];
			const argStartIndex = lines[i].indexOf(arg, (j === 0) ? lines[i].indexOf(tokens[0]) + tokens[0].length : lines[i].indexOf(args[j - 1]) + args[j - 1].length);

			// Check Registers
			if (registerRegex.test(arg) && !knownRegisters.has(arg)) {
				problems++;
				const message = `Unknown register: ${arg}`;
				// Suggestion for registers (optional, might be noisy if many R# registers)
				// const suggestion = findClosestMatch(arg, knownRegisters);
				// if (suggestion) {
				// 	message += `. Did you mean '${suggestion}'?`;
				// }
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range: { start: { line: i, character: argStartIndex }, end: { line: i, character: argStartIndex + arg.length } },
					message: message,
					source: 'microasm-ls'
				});
			}
			// Check Label References
			else if (arg.startsWith('#')) {
				if (!labelRegex.test(arg)) {
					problems++;
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						range: { start: { line: i, character: argStartIndex }, end: { line: i, character: argStartIndex + arg.length } },
						message: `Invalid label format: ${arg}`, source: 'microasm-ls'
					});
				} else {
					const labelName = arg.substring(1);
					if (jumpInstructions.has(instruction) && !allLabels.has(labelName)) {
						problems++;
						let message = `Undefined label: ${arg}`;
						const suggestion = findClosestMatch(labelName, allLabels.keys());
						const data: { suggestion?: string } = {}; // Prepare data object
						if (suggestion) {
							const fullSuggestion = `#${suggestion}`;
							message += `. Did you mean '${fullSuggestion}'?`;
							data.suggestion = fullSuggestion; // Store suggestion (with '#') in data
						}
						diagnostics.push({
							severity: DiagnosticSeverity.Error,
							range: { start: { line: i, character: argStartIndex }, end: { line: i, character: argStartIndex + arg.length } },
							message: message,
							source: 'microasm-ls',
							data: data // Attach data to diagnostic
						});
					}
				}
			}
			// Check Memory Address References ($)
			else if (arg.startsWith('$')) {
				if (!isValidMemoryAddress(arg)) {
					problems++;
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						range: { start: { line: i, character: argStartIndex }, end: { line: i, character: argStartIndex + arg.length } },
						message: `Invalid memory address format: ${arg}. Expected $number or $[expression].`, source: 'microasm-ls'
					});
				} else if (!allDbAddresses.has(arg)) { // Use the combined 'allDbAddresses' map
					if (instruction === 'OUT' && j === 1) { // Example check
						problems++;
						diagnostics.push({
							severity: DiagnosticSeverity.Warning,
							range: { start: { line: i, character: argStartIndex }, end: { line: i, character: argStartIndex + arg.length } },
							message: `Memory address ${arg} not defined by DB in this file or includes.`, source: 'microasm-ls'
						});
					}
				}
			}
			// TODO: Add checks for immediate values, specific argument types per instruction

			// Track references for unused symbol diagnostics
			if (arg.startsWith('#') && labelRegex.test(arg)) {
				referencedLabels.add(arg.substring(1));
			}
			if (arg.startsWith('$') && isValidMemoryAddress(arg)) {
				referencedDbAddresses.add(arg);
			}
		}

		// --- Mark unreachable after unconditional instructions ---
		if (['HLT', 'JMP', 'EXIT'].includes(instruction)) {
			unreachable = true;
			unreachableStartLine = i;
			unreachableStartInstr = instruction;
		}

		// Add MNI specific checks
		if (instruction === 'MNI' && args.length > 0) {
			const funcName = args[0]; // e.g., Math.sin
			const spec = mniSpecMap.get(funcName);
			if (!spec) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range: { start: { line: i, character: line.indexOf(funcName) }, end: { line: i, character: line.indexOf(funcName) + funcName.length } },
					message: `Unknown MNI function: ${funcName}`,
					source: 'microasm-ls'
				});
			} else {
				// Check argument count
				const expected = spec.args.length;
				const got = args.length - 1;
				if (got !== expected) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						range: { start: { line: i, character: 0 }, end: { line: i, character: line.length } },
						message: `MNI ${funcName} expects ${expected} arguments, got ${got}.`,
						source: 'microasm-ls'
					});
				} else {
					// Optionally check argument types
					for (let k = 0; k < expected; k++) {
						const expectedType = spec.args[k];
						const actualArg = args[k + 1];
						let typeOk = false;
						if (expectedType === 'register' && registerRegex.test(actualArg)) {typeOk = true;}
						if (expectedType === 'memory' && isValidMemoryAddress(actualArg)) {typeOk = true;}
						// Add more types as needed
						if (!typeOk) {
							diagnostics.push({
								severity: DiagnosticSeverity.Error,
								range: { start: { line: i, character: line.indexOf(actualArg) }, end: { line: i, character: line.indexOf(actualArg) + actualArg.length } },
								message: `Argument ${k + 1} of MNI ${funcName} expects ${expectedType}, got '${actualArg}'.`,
								source: 'microasm-ls'
							});
						}
					}
				}
			}
		}
	}

	// --- Unused Symbols ---
	for (const [label, def] of allLabels) {
		if (label === 'main') {continue;} // Exclude 'main' label from unused check
		if (!referencedLabels.has(label)) {
			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				range: { start: { line: def.line, character: 0 }, end: { line: def.line, character: 0 } },
				message: `Label '${label}' defined but never referenced.`,
				source: 'microasm-ls'
			});
		}
	}
	for (const [addr, def] of allDbAddresses) {
		if (!referencedDbAddresses.has(addr)) {
			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				range: { start: { line: def.line, character: 0 }, end: { line: def.line, character: 0 } },
				message: `DB address '${addr}' defined but never referenced.`,
				source: 'microasm-ls'
			});
		}
	}

	// Filter diagnostics to ensure they belong to the current document URI before returning
	const finalDiagnostics = diagnostics.filter(diag => {
		// Check if the diagnostic has relatedInformation pointing outside, or if it's an include error reported for this file
		if (diag.message.includes('Include file not found') || diag.message.includes('Circular include detected') || diag.message.includes('Failed to resolve include path')) {
			return true; // Keep include errors reported against this file's #include lines
		}
		// A simple check, might need refinement if diagnostics can originate from included files but point to the main file
		return true; // For now, assume all other diagnostics apply to the current file
	});


	// Use settings.maxNumberOfProblems which is now guaranteed to exist
	return finalDiagnostics.slice(0, settings.maxNumberOfProblems); // Ensure limit isn't exceeded
}

function getInstructionExample(instruction: string): string {
    const examples: Record<string, string> = {
        'MOV': 'MOV RAX RBX  ; Copy value from RBX to RAX',
        'ADD': 'ADD RAX 10   ; Add 10 to RAX',
        'JMP': 'JMP #label   ; Jump to label',
        // ...add more examples
    };
    return examples[instruction] || `${instruction} arg1 arg2`;
}