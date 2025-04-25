import * as fs from 'fs';
import * as path from 'path';

export interface MicroASMToolchain {
	name: string;
	version: string;
	includesDir: string;
	mniSpecsDir: string;
	rootDir: string;
}

export function findToolchain(startDir: string): MicroASMToolchain | null {
	let dir = startDir;
	while (true) {
		const tmasPath = path.join(dir, 'MicroASM.tmas');
		if (fs.existsSync(tmasPath)) {
			const json = JSON.parse(fs.readFileSync(tmasPath, 'utf-8'));
			return {
				...json,
				rootDir: dir,
				includesDir: path.resolve(dir, json.includesDir),
				mniSpecsDir: path.resolve(dir, json.mniSpecsDir)
			};
		}
		const parent = path.dirname(dir);
		if (parent === dir) {break;}
		dir = parent;
	}
	return null;
}
