/* --------------------------------------------------------------------------------------------
 * Copyright (c) Finite, all rights reserved.
 * ------------------------------------------------------------------------------------------ */
import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	DocumentDiagnosticReportKind,
	type DocumentDiagnosticReport,
	Position,
	Range,
	CodeAction,
	CodeActionKind,
	CodeActionParams,
	WorkspaceEdit,
	TextEdit,
	Location, // Add Location import
	ReferenceParams, // Add ReferenceParams import
	DefinitionParams, // Add DefinitionParams import
	Hover, // Add Hover import
	MarkupKind, // Add MarkupKind import
	DocumentSymbol, // Add DocumentSymbol import
	SymbolKind, // Add SymbolKind import
	SemanticTokensBuilder,
	SemanticTokensLegend,
	SemanticTokensParams
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { formatDocument } from './formatting';
import { provideCompletion } from './completion';
import { validateTextDocument } from './validation';
import { findToolchain } from './toolchain';
import { loadMNISpecs } from './mniSpec';

const mniSpecDir = path.join(__dirname, '..', 'mni-specs');
const mniSpecMap = loadMNISpecs(mniSpecDir);

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents = new TextDocuments(TextDocument);

// Log server startup
connection.console.log('MicroASM Language Server starting...');

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;
let toolchainPath: string | undefined = undefined; // Store the toolchain path

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;
	
	// Extract toolchain path from initialization options
	try {
		if (params.initializationOptions && params.initializationOptions.toolchainPath) {
			toolchainPath = params.initializationOptions.toolchainPath;
			connection.console.log(`Toolchain path received: ${toolchainPath}`);
		} else {
			connection.console.log('No toolchain path provided in initialization options');
		}
	} catch (error) {
		connection.console.error(`Error extracting toolchain path: ${error}`);
	}

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			completionProvider: {
				resolveProvider: true
			},
			diagnosticProvider: {
				interFileDependencies: false, // Set to true if includes affect diagnostics across files
				workspaceDiagnostics: false
			},
			// Announce code action capability
			codeActionProvider: {
				codeActionKinds: [CodeActionKind.QuickFix]
			},
			definitionProvider: true, // Add definition provider
			referencesProvider: true, // Add references provider
			documentFormattingProvider: true, // Add formatting provider
			hoverProvider: true, // Add hover provider
			documentSymbolProvider: true, // Add document symbol provider
			semanticTokensProvider: {
				legend: {
					tokenTypes: ['instruction', 'register', 'label', 'memoryAddress', 'immediate'],
					tokenModifiers: ['definition', 'reference', 'deprecated']
				},
				full: true
			}
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// The example settings
interface ExampleSettings {
	maxNumberOfProblems: number;
	includePath?: string; // Add optional include path setting
}


const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000, includePath: undefined }; // Default to undefined
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings = new Map<string, Thenable<ExampleSettings>>();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = (
			(change.settings.microasm || defaultSettings) // Changed from languageServerExample
		);
	}
	// Clear the parse cache as include paths might have changed
	parsedDocCache.clear();
	// Refresh the diagnostics since settings could have changed.
	connection.languages.diagnostics.refresh();
});

export function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'microasm' // Changed from languageServerExample
		});
		documentSettings.set(resource, result);
	}
	return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

// --- MicroASM Specific Data ---
// Basic list of known instructions
const knownInstructions = new Set([
	'MOV', 'ADD', 'SUB', 'MUL', 'DIV', 'INC', // Basic
	'JMP', 'CMP', 'JE', 'JL', 'CALL',        // Flow Control
	'PUSH', 'POP',                           // Stack
	'IN', 'OUT', 'COUT',                     // I/O
	'HLT', 'EXIT',                           // Program Control
	'ARGC', 'GETARG',                        // Args
	'DB',                                    // Data Def
	'LBL',                                   // Labels
	'AND', 'OR', 'XOR', 'NOT', 'SHL', 'SHR', // Bitwise
	'MOVADDR', 'MOVTO',                      // Memory Ext
	'JNE', 'JG', 'JLE', 'JGE',                // Flow Control Ext
	'ENTER', 'LEAVE',                        // Stack Frame
	'COPY', 'FILL', 'CMP_MEM',               // String/Memory
	'MNI'                                    // MNI
].map(instr => instr.toUpperCase()));

// Instructions that take a label argument (potentially)
const jumpInstructions = new Set(['JMP', 'JE', 'JL', 'CALL', 'JNE', 'JG', 'JLE', 'JGE'].map(instr => instr.toUpperCase()));

// Known Registers
const knownRegisters = new Set([
	'RAX', 'RBX', 'RCX', 'RDX', 'RSI', 'RDI', 'RBP', 'RSP', 'RIP',
	'R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15'
]);

// Instruction argument counts (min, max). Use -1 for variable/complex cases like DB, MNI.
const instructionArgCounts: Record<string, { min: number, max: number }> = {
	'MOV': { min: 2, max: 2 }, 'ADD': { min: 2, max: 2 }, 'SUB': { min: 2, max: 2 },
	'MUL': { min: 2, max: 2 }, 'DIV': { min: 2, max: 2 }, 'INC': { min: 1, max: 1 },
	'JMP': { min: 1, max: 1 }, 'CMP': { min: 2, max: 2 }, 'JE': { min: 1, max: 2 }, // JE can have 1 or 2 labels
	'JL': { min: 1, max: 1 }, 'CALL': { min: 1, max: 1 }, 'PUSH': { min: 1, max: 1 },
	'POP': { min: 1, max: 1 }, 'IN': { min: 1, max: 1 }, 'OUT': { min: 2, max: 2 },
	'COUT': { min: 2, max: 2 }, 'HLT': { min: 0, max: 0 }, 'EXIT': { min: 1, max: 1 },
	'ARGC': { min: 1, max: 1 }, 'GETARG': { min: 2, max: 2 }, 'DB': { min: 2, max: -1 }, // Address + string parts
	'LBL': { min: 1, max: 1 }, 'AND': { min: 2, max: 2 }, 'OR': { min: 2, max: 2 },
	'XOR': { min: 2, max: 2 }, 'NOT': { min: 1, max: 1 }, 'SHL': { min: 2, max: 2 },
	'SHR': { min: 2, max: 2 }, 'MOVADDR': { min: 3, max: 3 }, 'MOVTO': { min: 3, max: 3 },
	'JNE': { min: 1, max: 1 }, 'JG': { min: 1, max: 1 }, 'JLE': { min: 1, max: 1 },
	'JGE': { min: 1, max: 1 }, 'ENTER': { min: 1, max: 1 }, 'LEAVE': { min: 0, max: 0 },
	'COPY': { min: 3, max: 3 }, 'FILL': { min: 3, max: 3 }, 'CMP_MEM': { min: 3, max: 3 },
	'MNI': { min: 1, max: -1 } // Function name + args
};

// Simple instruction details (expand this)
const instructionDetails: Record<string, { detail: string, documentation: string }> = {
	'MOV': { detail: 'MOV dest src', documentation: 'Copies a value from source to destination.' },
	'ADD': { detail: 'ADD dest src', documentation: 'Adds source to destination.' },
	'SUB': { detail: 'SUB dest src', documentation: 'Subtracts source from destination.' },
	'MUL': { detail: 'MUL dest src', documentation: 'Multiplies destination by source.' },
	'DIV': { detail: 'DIV dest src', documentation: 'Divides destination by source.' },
	'INC': { detail: 'INC dest', documentation: 'Increments destination by 1.' },
	'JMP': { detail: 'JMP label', documentation: 'Unconditionally jumps to label (#label).' },
	'CMP': { detail: 'CMP dest src', documentation: 'Compares two values (registers, memory, immediate).' },
	'JE': { detail: 'JE label_true [label_false]', documentation: 'Jumps if equal. Optional second label for false case.' },
	'JL': { detail: 'JL label', documentation: 'Jumps if less than.' },
	'CALL': { detail: 'CALL target', documentation: 'Calls a function label (#label) or external ($function).' },
	'PUSH': { detail: 'PUSH src', documentation: 'Pushes value (register, memory, immediate) onto the stack.' },
	'POP': { detail: 'POP dest', documentation: 'Pops value from stack into destination register.' },
	'IN': { detail: 'IN $address', documentation: 'Reads stdin into memory address.' },
	'OUT': { detail: 'OUT port value', documentation: 'Outputs value (register, $address, immediate) to stdout (1) or stderr (2).' },
	'COUT': { detail: 'COUT port value', documentation: 'Outputs single character (ASCII value) to stdout (1) or stderr (2).' },
	'HLT': { detail: 'HLT', documentation: 'Halts program execution.' },
	'EXIT': { detail: 'EXIT code', documentation: 'Exits program with code (register, immediate).' },
	'ARGC': { detail: 'ARGC dest', documentation: 'Gets argument count into destination register.' },
	'GETARG': { detail: 'GETARG dest index', documentation: 'Gets argument at index (register, immediate) into destination register.' },
	'DB': { detail: 'DB $address "string"', documentation: 'Defines bytes (string) at a memory address.' },
	'LBL': { detail: 'LBL name', documentation: 'Defines a label for jumps/calls.' },
	'AND': { detail: 'AND dest src', documentation: 'Bitwise AND.' },
	'OR': { detail: 'OR dest src', documentation: 'Bitwise OR.' },
	'XOR': { detail: 'XOR dest src', documentation: 'Bitwise XOR.' },
	'NOT': { detail: 'NOT dest', documentation: 'Bitwise NOT.' },
	'SHL': { detail: 'SHL dest count', documentation: 'Bitwise shift left.' },
	'SHR': { detail: 'SHR dest count', documentation: 'Bitwise shift right.' },
	'MOVADDR': { detail: 'MOVADDR dest src offset', documentation: 'Moves value from memory [src + offset] to dest.' },
	'MOVTO': { detail: 'MOVTO dest offset src', documentation: 'Moves value from src to memory [dest + offset].' },
	'JNE': { detail: 'JNE label', documentation: 'Jumps if not equal.' },
	'JG': { detail: 'JG label', documentation: 'Jumps if greater than.' },
	'JLE': { detail: 'JLE label', documentation: 'Jumps if less than or equal.' },
	'JGE': { detail: 'JGE label', documentation: 'Jumps if greater than or equal.' },
	'ENTER': { detail: 'ENTER framesize', documentation: 'Creates a stack frame.' },
	'LEAVE': { detail: 'LEAVE', documentation: 'Destroys the current stack frame.' },
	'COPY': { detail: 'COPY dest src len', documentation: 'Copies memory.' },
	'FILL': { detail: 'FILL dest value len', documentation: 'Fills memory.' },
	'CMP_MEM': { detail: 'CMP_MEM dest src len', documentation: 'Compares memory regions.' },
	'MNI': { detail: 'MNI function [args...]', documentation: 'Micro Native Interface call.' },
};

// Regex patterns
const labelRegex = /^#[a-zA-Z_][a-zA-Z0-9_]*$/;
const registerRegex = /^(RAX|RBX|RCX|RDX|RSI|RDI|RBP|RSP|RIP|R[0-9]|R1[0-5])$/;
// Basic memory address regex - we'll use a function for complex validation
const memoryAddressRegex = /^\$(?:[0-9]+|\[.+\])$/;
const immediateValueRegex = /^[0-9]+$/; // Simple check for digits
const includeRegex = /^#include\s+"([^"]+)"$/i; // Basic include pattern

// Function to validate complex memory address expressions
function isValidMemoryAddress(address: string): boolean {
	if (!address.startsWith('$')) {
		return false;
	}
	
	const content = address.substring(1); // Remove the $
	
	// Simple numeric address: $123
	if (/^[0-9]+$/.test(content)) {
		return true;
	}
	
	// Bracket expression: $[...]
	if (!content.startsWith('[') || !content.endsWith(']')) {
		return false;
	}
	
	const expr = content.slice(1, -1); // Remove [ and ]
	
	// Empty brackets
	if (expr.length === 0) {
		return false;
	}
	
	// Valid patterns:
	// 1. register: rbp, rax, etc.
	// 2. register+number: rbp+4, rax-8
	// 3. register+register: rbp+rcx
	// 4. register+register*scale: rbp+rcx*2
	// 5. number: 123
	// 6. Combinations of the above
	
	// Split by + and - while keeping the operators
	const parts = expr.split(/([+\-])/).filter(part => part.length > 0);
	
	if (parts.length === 0) {
		return false;
	}
	
	// First part cannot be an operator
	if (parts[0] === '+' || parts[0] === '-') {
		return false;
	}
	
	// Check each part
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		
		if (part === '+' || part === '-') {
			// Operators must be followed by a value
			if (i === parts.length - 1) {
				return false;
			}
			continue;
		}
		
		// Check if it's a number
		if (/^[0-9]+$/.test(part)) {
			continue;
		}
		
		// Check if it's a register
		if (registerRegex.test(part)) {
			continue;
		}
		
		// Check if it's a register with scale (e.g., rcx*2)
		const scaleMatch = part.match(/^(RAX|RBX|RCX|RDX|RSI|RDI|RBP|RSP|RIP|R[0-9]|R1[0-5])\*([1-8])$/);
		if (scaleMatch) {
			continue;
		}
		
		// Invalid part
		return false;
	}
	
	return true;
}

// --- End MicroASM Specific Data ---

// --- Document Cache ---
interface ParsedDocInfo {
	labels: Map<string, { line: number, uri: string }>; // Store definition line and URI
	dbAddresses: Map<string, { line: number, size: number, uri: string }>; // Store definition line, size, and URI
	includeErrors: Diagnostic[]; // Store errors encountered during include parsing
}
const parsedDocCache = new Map<string, ParsedDocInfo>(); // Cache stores fully resolved info for a URI
// --- End Document Cache ---

// --- Levenshtein Distance Function ---
function levenshteinDistance(a: string, b: string): number {
	if (a.length === 0) {return b.length;}
	if (b.length === 0) {return a.length;}

	const matrix = [];

	// increment along the first column of each row
	for (let i = 0; i <= b.length; i++) {
		matrix[i] = [i];
	}

	// increment each column in the first row
	for (let j = 0; j <= a.length; j++) {
		matrix[0][j] = j;
	}

	// Fill in the rest of the matrix
	for (let i = 1; i <= b.length; i++) {
		for (let j = 1; j <= a.length; j++) {
			const cost = (b.charAt(i - 1) === a.charAt(j - 1)) ? 0 : 1;
			matrix[i][j] = Math.min(
				matrix[i - 1][j] + 1, // deletion
				matrix[i][j - 1] + 1, // insertion
				matrix[i - 1][j - 1] + cost // substitution
			);
		}
	}

	return matrix[b.length][a.length];
}

// Helper to find the closest match using Levenshtein distance
function findClosestMatch(input: string, options: Iterable<string>, maxDistance = 2): string | null {
	let bestMatch: string | null = null;
	let minDistance = maxDistance + 1;

	for (const option of options) {
		const distance = levenshteinDistance(input.toLowerCase(), option.toLowerCase()); // Case-insensitive comparison
		if (distance < minDistance && distance <= maxDistance) {
			minDistance = distance;
			bestMatch = option;
		}
	}
	return bestMatch;
}
// --- End Levenshtein Distance Function ---

connection.languages.diagnostics.on(async (params) => {
	const document = documents.get(params.textDocument.uri);
	if (document !== undefined) {
		return {
			kind: DocumentDiagnosticReportKind.Full,
			items: await validateTextDocument(
				document,
				async (uri) => await getDocumentSettings(uri),
				defaultSettings,
				getParsedDocInfo,
				includeRegex,
				memoryAddressRegex,
				isValidMemoryAddress, // Add the validation function
				knownInstructions,
				instructionArgCounts,
				registerRegex,
				knownRegisters,
				labelRegex,
				jumpInstructions,
				findClosestMatch,
				mniSpecMap, // Pass mniSpecMap to validation
				toolchainPath // Add toolchain path
			)
		} satisfies DocumentDiagnosticReport;
	} else {
		return {
			kind: DocumentDiagnosticReportKind.Full,
			items: []
		} satisfies DocumentDiagnosticReport;
	}
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	// Invalidate cache for the changed document and potentially others that include it (complex to track, simple invalidation for now)
	parsedDocCache.delete(change.document.uri);
	validateTextDocument(
		change.document,
		async (uri) => await getDocumentSettings(uri),
		defaultSettings,
		getParsedDocInfo,
		includeRegex,
		memoryAddressRegex,
		isValidMemoryAddress, // Add the validation function
		knownInstructions,
		instructionArgCounts,
		registerRegex,
		knownRegisters,
		labelRegex,
		jumpInstructions,
		findClosestMatch,
		mniSpecMap, // <-- add this argument
		toolchainPath // Add toolchain path
	);
});

// Clears the cache when watched files change (e.g., an included file is saved)
connection.onDidChangeWatchedFiles(_change => {
	connection.console.log('Watched file changed, clearing parsed document cache.');
	parsedDocCache.clear();
	// Trigger revalidation of open documents
	documents.all().forEach(async doc => await validateTextDocument(
		doc,
		async (uri) => await getDocumentSettings(uri),
		defaultSettings,
		getParsedDocInfo,
		includeRegex,
		memoryAddressRegex,
		isValidMemoryAddress, // Add the validation function
		knownInstructions,
		instructionArgCounts,
		registerRegex,
		knownRegisters,
		labelRegex,
		jumpInstructions,
		findClosestMatch,
		mniSpecMap, // <-- add this argument
		toolchainPath // Add toolchain path
	));
});

// Recursive function to parse a document and its includes
function parseDocumentRecursive(
	docUri: string,
	visitedUris: Set<string>, // For circular dependency detection
	configuredIncludePath: string | undefined, // Pass down the configured path
	originErrorRange?: { line: number, range: Range } // For reporting include errors at the #include line
): ParsedDocInfo {

	const cached = parsedDocCache.get(docUri);
	if (cached) {
		// If cached, return it but potentially add an error if this path led to a circular dependency
		if (visitedUris.has(docUri) && originErrorRange) {
			return {
				...cached,
				includeErrors: [
					...cached.includeErrors,
					{
						severity: DiagnosticSeverity.Error,
						range: originErrorRange.range,
						message: `Circular include detected: ${URI.parse(docUri).fsPath}`,
						source: 'microasm-ls'
					}
				]
			};
		}
		return cached;
	}

	if (visitedUris.has(docUri)) {
		// Circular dependency detected
		const error: Diagnostic = {
			severity: DiagnosticSeverity.Error,
			range: originErrorRange?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, // Default range if origin unknown
			message: `Circular include detected: ${URI.parse(docUri).fsPath}`,
			source: 'microasm-ls'
		};
		return { labels: new Map(), dbAddresses: new Map(), includeErrors: [error] };
	}

	// Add to visited set for this path
	visitedUris.add(docUri);

	const currentLabels = new Map<string, { line: number, uri: string }>();
	const currentDbAddresses = new Map<string, { line: number, size: number, uri: string }>();
	const currentIncludeErrors: Diagnostic[] = [];
	let fileContent: string;
	let documentObject: TextDocument | undefined = documents.get(docUri); // Check if open

	try {
		if (!documentObject) {
			// If not open, read from disk
			const filePath = URI.parse(docUri).fsPath;
			fileContent = fs.readFileSync(filePath, 'utf-8');
			// Create a temporary TextDocument for consistent line processing
			documentObject = TextDocument.create(docUri, 'microasm', 0, fileContent);
		} else {
			fileContent = documentObject.getText();
		}

		const lines = fileContent.split(/\r?\n/g);
		const currentDocDir = path.dirname(URI.parse(docUri).fsPath); // Get directory of the current file

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (line.length === 0 || line.startsWith(';')) {continue;}

			const includeMatch = line.match(includeRegex);
			if (includeMatch) {
				const includeFilename = includeMatch[1]; // e.g., "stdlib.masm"
				let foundPath: string | null = null;
				let resolvedUri: URI | null = null;

				// 1. Check configured include path first, *only if it's defined and not empty*
				if (configuredIncludePath) { // Check if the path string is truthy
					try {
						const potentialPath = path.resolve(configuredIncludePath, includeFilename); // Use path.resolve for robustness
						if (fs.existsSync(potentialPath)) {
							foundPath = potentialPath;
							resolvedUri = URI.file(foundPath);
						}
					} catch (e) {
						// Ignore errors during this check (e.g., invalid configured path)
						connection.console.warn(`Error checking configured include path '${configuredIncludePath}': ${e}`);
					}
				}

				// 2. If not found in configured path (or if path wasn't checked), check relative to the current file
				if (!foundPath) {
					try {
						const potentialPath = path.resolve(currentDocDir, includeFilename); // Use path.resolve
						if (fs.existsSync(potentialPath)) {
							foundPath = potentialPath;
							resolvedUri = URI.file(foundPath);
						}
					} catch (e) {
						// Ignore errors during relative path check
						connection.console.warn(`Error checking relative include path '${currentDocDir}': ${e}`);
					}
				}

				// 3. Process if found, otherwise report error
				if (resolvedUri) {
					const includeRange = { start: { line: i, character: lines[i].indexOf(includeFilename) }, end: { line: i, character: lines[i].indexOf(includeFilename) + includeFilename.length } };
					// Pass configuredIncludePath down recursively
					const includedInfo = parseDocumentRecursive(resolvedUri.toString(), new Set(visitedUris), configuredIncludePath, { line: i, range: includeRange });

					// Merge results from included file
					includedInfo.labels.forEach((val, key) => {
						if (!currentLabels.has(key)) {currentLabels.set(key, val);} // Keep first definition
					});
					includedInfo.dbAddresses.forEach((val, key) => {
						if (!currentDbAddresses.has(key)) {currentDbAddresses.set(key, val);} // Keep first definition
					});
					currentIncludeErrors.push(...includedInfo.includeErrors);

				} else {
					// File not found in either location
					let errorMsg = `Include file not found: ${includeFilename}`;
					// Adjust error message based on whether configured path was searched
					if (configuredIncludePath) {
						errorMsg += ` (Searched in '${configuredIncludePath}' and '${currentDocDir}')`;
					} else {
						errorMsg += ` (Searched in '${currentDocDir}')`;
					}
					currentIncludeErrors.push({
						severity: DiagnosticSeverity.Error,
						range: { start: { line: i, character: lines[i].indexOf(includeFilename) }, end: { line: i, character: lines[i].indexOf(includeFilename) + includeFilename.length } },
						message: errorMsg,
						source: 'microasm-ls'
					});
				}
				continue; // Skip LBL/DB parsing for include lines

			} else {
				// Parse LBL and DB (only for the current file)
				const tokens = line.split(/\s+/);
				const instruction = tokens[0].toUpperCase();

				if (instruction === 'LBL' && tokens.length > 1) {
					const labelName = tokens[1];
					if (!currentLabels.has(labelName)) { // Only store first definition within this scope
						currentLabels.set(labelName, { line: i, uri: docUri });
					}
					} else if (instruction === 'DB' && tokens.length >= 3) {
					const addressArg = tokens[1];
					if (isValidMemoryAddress(addressArg) && !currentDbAddresses.has(addressArg)) {
						const stringLiteral = line.substring(line.indexOf(tokens[2])).trim();
						let size = 0;
						if (stringLiteral.startsWith('"') && stringLiteral.endsWith('"')) {
							size = stringLiteral.length - 2;
						}
						currentDbAddresses.set(addressArg, { line: i, size: size, uri: docUri });
					}
				}
			}
		}

	} catch (error) {
		// File not found or other reading error for the *current* docUri
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			currentIncludeErrors.push({
				severity: DiagnosticSeverity.Error,
				range: originErrorRange?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
				message: `Include file not found: ${URI.parse(docUri).fsPath}`,
				source: 'microasm-ls'
			});
		} else {
			// Log other errors
			connection.console.error(`Error parsing ${docUri}: ${error}`);
			currentIncludeErrors.push({
				severity: DiagnosticSeverity.Error,
				range: originErrorRange?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
				message: `Error reading include file: ${URI.parse(docUri).fsPath}`,
				source: 'microasm-ls'
			});
		}
	}

	// Remove self from visited set before returning up the stack
	// visitedUris.delete(docUri); // Not needed if we pass copies down

	const result: ParsedDocInfo = { labels: currentLabels, dbAddresses: currentDbAddresses, includeErrors: currentIncludeErrors };
	parsedDocCache.set(docUri, result); // Cache the fully resolved result
	return result;
}


// Modified getParsedDocInfo to accept and pass the include path
export async function getParsedDocInfo(textDocument: TextDocument, configuredIncludePath: string | undefined): Promise<ParsedDocInfo> {
	// Use the recursive parser starting with an empty visited set
	return parseDocumentRecursive(textDocument.uri, new Set<string>(), configuredIncludePath);
}



// --- Code Action Provider ---
connection.onCodeAction((params: CodeActionParams): CodeAction[] | undefined => {
	const textDocument = documents.get(params.textDocument.uri);
	if (!textDocument) {
		return undefined;
	}

	const codeActions: CodeAction[] = [];
	for (const diag of params.context.diagnostics) {
		// Check if the diagnostic has suggestion data
		if (diag.data && typeof (diag.data as any).suggestion === 'string') {
			const suggestion = (diag.data as any).suggestion as string;
			const originalText = textDocument.getText(diag.range); // Get the text covered by the diagnostic

			// Create the text edit to replace the incorrect text with the suggestion
			const textEdit = TextEdit.replace(diag.range, suggestion);

			// Create the workspace edit
			const workspaceEdit: WorkspaceEdit = {
				changes: {
					[params.textDocument.uri]: [textEdit]
				}
			};

			// Create the code action
			const codeAction: CodeAction = {
				title: `Replace '${originalText}' with '${suggestion}'`,
				kind: CodeActionKind.QuickFix,
				diagnostics: [diag], // Associate with the diagnostic
				edit: workspaceEdit
			};
			codeActions.push(codeAction);
		}
	}

	return codeActions;
});
// --- End Code Action Provider ---

// --- Document Formatting Provider ---
connection.onDocumentFormatting((params, _token, _workDoneProgress, _resultProgress) => {
	const document = documents.get(params.textDocument.uri);
	if (!document) {return [];}
	return formatDocument(document);
});

// --- Completion Provider ---
connection.onCompletion(
	async (textDocumentPosition) => {
		return provideCompletion(
			textDocumentPosition,
			documents,
			knownInstructions,
			knownRegisters,
			jumpInstructions,
			getDocumentSettings,
			defaultSettings,
			getParsedDocInfo
		);
	}
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		const key = typeof item.data === 'string' ? item.data : item.label;

		// Check if it's an instruction
		const instructionInfo = instructionDetails[key];
		if (instructionInfo) {
			item.detail = instructionInfo.detail;
			item.documentation = instructionInfo.documentation;
		}
		// Check if it's a register
		else if (knownRegisters.has(key)) {
			item.detail = 'Register';
			item.documentation = `General purpose register: ${key}`;
			if (key === 'RSP') {item.documentation = 'Stack Pointer Register';}
			if (key === 'RBP') {item.documentation = 'Base Pointer Register';}
			if (key === 'RIP') {item.documentation = 'Instruction Pointer Register';}
		}
		// Check if it's a label reference
		else if (key.startsWith('#')) {
			item.detail = 'Label Reference';
			item.documentation = `Jump/Call target: ${key}`;
			// Could potentially look up the definition line from cache here
		}
		// Check if it's a DB address reference
		else if (key.startsWith('$')) {
			item.detail = 'Memory Address';
			item.documentation = `Memory address defined by DB: ${key}`;
			// Could potentially look up the definition line/size from cache here
		}
		else {
			// Default fallback
			item.detail = `${item.label}`;
			item.documentation = 'No specific documentation available.';
		}
		return item;
	}
);

// --- Go to Definition Provider ---
connection.onDefinition((params: DefinitionParams): Location[] | undefined => {
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return undefined;
	}

	const position = params.position;
	const line = document.getText({
		start: { line: position.line, character: 0 },
		end: { line: position.line + 1, character: 0 }
	});

	// Get word at position
	const wordRange = getWordRangeAtPosition(document, position);
	if (!wordRange) {
		return undefined;
	}

	const word = document.getText(wordRange);
	
	// Handle label references (#label)
	if (word.startsWith('#')) {
		const labelName = word.substring(1);
		const parsedInfo = parsedDocCache.get(document.uri);
		if (parsedInfo && parsedInfo.labels.has(labelName)) {
			const labelDef = parsedInfo.labels.get(labelName)!;
			return [{
				uri: labelDef.uri,
				range: {
					start: { line: labelDef.line, character: 0 },
					end: { line: labelDef.line, character: 0 }
				}
			}];
		}
	}

	// Handle memory address references ($address)
	if (word.startsWith('$')) {
		const parsedInfo = parsedDocCache.get(document.uri);
		if (parsedInfo && parsedInfo.dbAddresses.has(word)) {
			const dbDef = parsedInfo.dbAddresses.get(word)!;
			return [{
				uri: dbDef.uri,
				range: {
					start: { line: dbDef.line, character: 0 },
					end: { line: dbDef.line, character: 0 }
				}
			}];
		}
	}

	return undefined;
});

// --- Find References Provider ---
connection.onReferences((params: ReferenceParams): Location[] | undefined => {
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return undefined;
	}

	const position = params.position;
	const wordRange = getWordRangeAtPosition(document, position);
	if (!wordRange) {
		return undefined;
	}

	const word = document.getText(wordRange);
	const references: Location[] = [];

	// Search through all open documents
	for (const doc of documents.all()) {
		const text = doc.getText();
		const lines = text.split(/\r?\n/g);

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			let searchWord = word;
			
			// If we're looking for a label, search for both LBL definition and #references
			if (word.startsWith('#')) {
				const labelName = word.substring(1);
				// Find LBL definitions
				const lblMatch = line.match(new RegExp(`\\bLBL\\s+(${labelName})\\b`, 'i'));
				if (lblMatch) {
					const startChar = line.indexOf(lblMatch[1]);
					references.push({
						uri: doc.uri,
						range: {
							start: { line: i, character: startChar },
							end: { line: i, character: startChar + lblMatch[1].length }
						}
					});
				}
				searchWord = word; // Also search for #references
			}

			// Find all occurrences of the word
			let index = line.indexOf(searchWord);
			while (index !== -1) {
				references.push({
					uri: doc.uri,
					range: {
						start: { line: i, character: index },
						end: { line: i, character: index + searchWord.length }
					}
				});
				index = line.indexOf(searchWord, index + 1);
			}
		}
	}

	return references;
});

// Helper function to get word range at position
function getWordRangeAtPosition(document: TextDocument, position: Position): Range | undefined {
	const line = document.getText({
		start: { line: position.line, character: 0 },
		end: { line: position.line + 1, character: 0 }
	});

	const wordPattern = /[\w$#]+/g;
	let match;
	while ((match = wordPattern.exec(line)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		if (position.character >= start && position.character <= end) {
			return {
				start: { line: position.line, character: start },
				end: { line: position.line, character: end }
			};
		}
	}
	return undefined;
}

// --- Hover Provider ---
connection.onHover((params): Hover | undefined => {
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return undefined;
	}

	const position = params.position;
	const wordRange = getWordRangeAtPosition(document, position);
	if (!wordRange) {
		return undefined;
	}

	const word = document.getText(wordRange);

	// Check if it's an instruction
	const instructionInfo = instructionDetails[word.toUpperCase()];
	if (instructionInfo) {
		return {
			contents: {
				kind: MarkupKind.Markdown,
				value: `**${word.toUpperCase()}**\n\n${instructionInfo.detail}\n\n${instructionInfo.documentation}`
			},
			range: wordRange
		};
	}

	// Check if it's a register
	if (knownRegisters.has(word.toUpperCase())) {
		let description = `General purpose register: ${word.toUpperCase()}`;
		if (word.toUpperCase() === 'RSP') description = 'Stack Pointer Register - Points to the top of the stack';
		if (word.toUpperCase() === 'RBP') description = 'Base Pointer Register - Points to the base of the current stack frame';
		if (word.toUpperCase() === 'RIP') description = 'Instruction Pointer Register - Holds the address of the next instruction';

		return {
			contents: {
				kind: MarkupKind.Markdown,
				value: `**Register: ${word.toUpperCase()}**\n\n${description}`
			},
			range: wordRange
		};
	}

	// Check if it's a label reference
	if (word.startsWith('#')) {
		const labelName = word.substring(1);
		const parsedInfo = parsedDocCache.get(document.uri);
		if (parsedInfo && parsedInfo.labels.has(labelName)) {
			const labelDef = parsedInfo.labels.get(labelName)!;
			return {
				contents: {
					kind: MarkupKind.Markdown,
					value: `**Label: ${word}**\n\nDefined at line ${labelDef.line + 1} in ${labelDef.uri}`
				},
				range: wordRange
			};
		}
	}

	// Check if it's a memory address
	if (word.startsWith('$')) {
		const parsedInfo = parsedDocCache.get(document.uri);
		if (parsedInfo && parsedInfo.dbAddresses.has(word)) {
			const dbDef = parsedInfo.dbAddresses.get(word)!;
			return {
				contents: {
					kind: MarkupKind.Markdown,
					value: `**Memory Address: ${word}**\n\nDefined at line ${dbDef.line + 1}, size: ${dbDef.size} bytes`
				},
				range: wordRange
			};
		}
	}

	return undefined;
});

// --- Document Symbol Provider ---
connection.onDocumentSymbol((params): DocumentSymbol[] | undefined => {
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return undefined;
	}

	const symbols: DocumentSymbol[] = [];
	const text = document.getText();
	const lines = text.split(/\r?\n/g);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line.length === 0 || line.startsWith(';')) {
			continue;
		}

		const tokens = line.split(/\s+/);
		const instruction = tokens[0].toUpperCase();

		// Labels
		if (instruction === 'LBL' && tokens.length > 1) {
			const labelName = tokens[1];
			symbols.push({
				name: labelName,
				kind: SymbolKind.Function,
				range: {
					start: { line: i, character: 0 },
					end: { line: i, character: line.length }
				},
				selectionRange: {
					start: { line: i, character: line.indexOf(labelName) },
					end: { line: i, character: line.indexOf(labelName) + labelName.length }
				}
			});
		}

		// Data definitions
		if (instruction === 'DB' && tokens.length >= 3) {
			const address = tokens[1];
			symbols.push({
				name: `Data at ${address}`,
				kind: SymbolKind.Variable,
				range: {
					start: { line: i, character: 0 },
					end: { line: i, character: line.length }
				},
				selectionRange: {
					start: { line: i, character: line.indexOf(address) },
					end: { line: i, character: line.indexOf(address) + address.length }
				}
			});
		}

		// STATE variables
		if (instruction === 'STATE' && tokens.length >= 3) {
			const varName = tokens[1];
			const varType = tokens[2];
			symbols.push({
				name: `${varName} ${varType}`,
				kind: SymbolKind.Variable,
				range: {
					start: { line: i, character: 0 },
					end: { line: i, character: line.length }
				},
				selectionRange: {
					start: { line: i, character: line.indexOf(varName) },
					end: { line: i, character: line.indexOf(varName) + varName.length }
				}
			});
		}

		// Macros
		if (instruction === 'MACRO' && tokens.length > 1) {
			const macroName = tokens[1];
			symbols.push({
				name: macroName,
				kind: SymbolKind.Class,
				range: {
					start: { line: i, character: 0 },
					end: { line: i, character: line.length }
				},
				selectionRange: {
					start: { line: i, character: line.indexOf(macroName) },
					end: { line: i, character: line.indexOf(macroName) + macroName.length }
				}
			});
		}
	}

	return symbols;
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

connection.console.log('MicroASM Language Server started and listening...');
