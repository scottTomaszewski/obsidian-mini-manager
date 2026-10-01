import { App, TFile, TFolder } from 'obsidian';

export function folderExists(app: App, path: string): boolean {
	return app.vault.getAbstractFileByPath(path) instanceof TFolder;
}

export function fileExists(app: App, path: string): boolean {
	return app.vault.getAbstractFileByPath(path) instanceof TFile;
}

export async function ensureFolder(app: App, path: string): Promise<void> {
	if (!folderExists(app, path)) {
		await app.vault.createFolder(path);
	}
}

export function abortError(): DOMException {
	return new DOMException('Aborted', 'AbortError');
}
