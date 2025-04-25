import * as fs from 'fs';
import * as path from 'path';

export interface MNIFunctionSpec { args: string[] }
export type MNISpecMap = Map<string, MNIFunctionSpec>;

export function loadMNISpecs(dir: string): MNISpecMap {
	const mniMap: MNISpecMap = new Map();
	if (!fs.existsSync(dir)) {return mniMap;}
	for (const file of fs.readdirSync(dir)) {
		if (!file.endsWith('.json')) {continue;}
		try {
			const json = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
			for (const ns in json) {
				for (const fn in json[ns]) {
					const key = `${ns}.${fn}`;
					mniMap.set(key, json[ns][fn]);
				}
			}
		} catch (err) {
			console.error(`[MNI] Failed to load ${file}:`, err);
		}
	}
	return mniMap;
}
