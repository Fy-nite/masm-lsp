import { TextDocument, TextEdit } from 'vscode-languageserver-textdocument';

export function formatDocument(document: TextDocument): TextEdit[] {
	const lines = document.getText().split(/\r?\n/g);
	const formattedLines = lines.map(line => {
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith(';')) {return trimmed;}
		const tokens = trimmed.split(/\s+/);
		if (tokens.length === 0) {return trimmed;}
		const instr = tokens[0].toUpperCase();
		const rest = tokens.slice(1).map(arg => {
			if (/^(RAX|RBX|RCX|RDX|RSI|RDI|RBP|RSP|RIP|R[0-9]|R1[0-5])$/i.test(arg)) {
				return arg.toUpperCase();
			}
			return arg;
		});
		return [instr, ...rest].join(' ');
	});
	return [
		{
			range: {
				start: { line: 0, character: 0 },
				end: { line: lines.length, character: 0 }
			},
			newText: formattedLines.join('\n')
		}
	];
}
