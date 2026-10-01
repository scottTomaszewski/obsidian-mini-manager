// Jest-facing stand-in for the `obsidian` module (see moduleNameMapper in jest.config.js).
// Only what the plugin's services touch is implemented. The adapter mirrors the desktop
// FileSystemAdapter where its behaviour matters to the plugin:
//   - mkdir is recursive and does NOT throw when the folder already exists
//   - rmdir throws ENOENT when the folder is missing
//   - requestUrl throws on status >= 400 unless called with `throw: false`

export function normalizePath(path: string): string {
	let result = path.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '');
	if (result === '') result = '/';
	return result.replace(/ /g, ' ').normalize('NFC');
}

export function stringifyYaml(obj: Record<string, unknown>): string {
	const scalar = (value: unknown): string =>
		typeof value === 'string' ? JSON.stringify(value) : String(value);
	let out = '';
	for (const [key, value] of Object.entries(obj)) {
		if (Array.isArray(value)) {
			out += value.length === 0 ? `${key}: []\n` : `${key}:\n${value.map(v => `  - ${scalar(v)}`).join('\n')}\n`;
		} else {
			out += `${key}: ${scalar(value)}\n`;
		}
	}
	return out;
}

/** The desktop adapter. FakeAdapter is deliberately not one, so code takes its portable path. */
export class FileSystemAdapter {}

export class TAbstractFile {
	path: string;
	name: string;
	constructor(path: string) {
		this.path = path;
		this.name = path.split('/').pop() ?? path;
	}
}

export class TFile extends TAbstractFile {}

export class TFolder extends TAbstractFile {}

function enoent(op: string, path: string): Error {
	return new Error(`ENOENT: no such file or directory, ${op} '${path}'`);
}

function parentOf(path: string): string {
	const idx = path.lastIndexOf('/');
	return idx === -1 ? '' : path.substring(0, idx);
}

/** In-memory DataAdapter. The vault root is the empty path. */
export class FakeAdapter {
	files = new Map<string, string | ArrayBuffer>();
	folders = new Set<string>(['']);

	private key(path: string): string {
		const normalized = normalizePath(path);
		return normalized === '/' ? '' : normalized;
	}

	private ensureFolders(path: string): void {
		let current = path;
		while (current !== '') {
			this.folders.add(current);
			current = parentOf(current);
		}
	}

	async exists(path: string): Promise<boolean> {
		const key = this.key(path);
		return this.files.has(key) || this.folders.has(key);
	}

	async stat(path: string): Promise<{ type: 'file' | 'folder'; size: number } | null> {
		const key = this.key(path);
		const file = this.files.get(key);
		if (file !== undefined) {
			return { type: 'file', size: typeof file === 'string' ? file.length : file.byteLength };
		}
		return this.folders.has(key) ? { type: 'folder', size: 0 } : null;
	}

	async read(path: string): Promise<string> {
		const value = this.files.get(this.key(path));
		if (value === undefined) throw enoent('open', path);
		return typeof value === 'string' ? value : new TextDecoder().decode(value);
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		const value = this.files.get(this.key(path));
		if (value === undefined) throw enoent('open', path);
		return typeof value === 'string' ? new TextEncoder().encode(value).buffer : value;
	}

	async write(path: string, data: string): Promise<void> {
		const key = this.key(path);
		if (!this.folders.has(parentOf(key))) throw enoent('open', path);
		this.files.set(key, data);
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		const key = this.key(path);
		if (!this.folders.has(parentOf(key))) throw enoent('open', path);
		this.files.set(key, data);
	}

	async append(path: string, data: string): Promise<void> {
		const key = this.key(path);
		if (!this.folders.has(parentOf(key))) throw enoent('open', path);
		const existing = this.files.get(key);
		this.files.set(key, (typeof existing === 'string' ? existing : '') + data);
	}

	async mkdir(path: string): Promise<void> {
		this.ensureFolders(this.key(path));
	}

	async rmdir(path: string, recursive: boolean): Promise<void> {
		const key = this.key(path);
		if (!this.folders.has(key)) throw enoent('rm', path);
		const prefix = `${key}/`;
		const hasChildren =
			[...this.files.keys()].some(f => f.startsWith(prefix)) ||
			[...this.folders].some(f => f.startsWith(prefix));
		if (hasChildren && !recursive) throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
		for (const file of [...this.files.keys()]) {
			if (file.startsWith(prefix)) this.files.delete(file);
		}
		for (const folder of [...this.folders]) {
			if (folder === key || folder.startsWith(prefix)) this.folders.delete(folder);
		}
	}

	async remove(path: string): Promise<void> {
		const key = this.key(path);
		if (!this.files.has(key)) throw enoent('unlink', path);
		this.files.delete(key);
	}

	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const key = this.key(path);
		if (!this.folders.has(key)) throw enoent('scandir', path);
		const isChild = (candidate: string) => candidate !== key && parentOf(candidate) === key;
		return {
			files: [...this.files.keys()].filter(isChild).sort(),
			folders: [...this.folders].filter(isChild).sort(),
		};
	}

	getFullPath(path: string): string {
		return `/fake-vault/${this.key(path)}`;
	}
}

/** Vault backed by a FakeAdapter. Like the real one, it does not index hidden paths. */
export class FakeVault {
	adapter = new FakeAdapter();
	configDir = '.obsidian';

	private isHidden(path: string): boolean {
		return path.split('/').some(segment => segment.startsWith('.'));
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		const key = normalizePath(path);
		if (this.isHidden(key)) return null;
		if (this.adapter.files.has(key)) return new TFile(key);
		if (key !== '/' && this.adapter.folders.has(key)) return new TFolder(key);
		return null;
	}

	async createFolder(path: string): Promise<TFolder> {
		const key = normalizePath(path);
		if (await this.adapter.exists(key)) throw new Error('Folder already exists.');
		await this.adapter.mkdir(key);
		return new TFolder(key);
	}

	async create(path: string, data: string): Promise<TFile> {
		const key = normalizePath(path);
		if (await this.adapter.exists(key)) throw new Error('File already exists.');
		await this.adapter.write(key, data);
		return new TFile(key);
	}

	async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
		const key = normalizePath(path);
		if (await this.adapter.exists(key)) throw new Error('File already exists.');
		await this.adapter.writeBinary(key, data);
		return new TFile(key);
	}

	async modify(file: TFile, data: string): Promise<void> {
		await this.adapter.write(file.path, data);
	}

	async read(file: TFile): Promise<string> {
		return this.adapter.read(file.path);
	}
}

export class App {
	vault = new FakeVault();
	// Private API the plugin uses to jump to its settings tab.
	setting = {
		open: jest.fn(),
		openTabById: jest.fn(),
	};
}

class FakeNoticeEl {
	buttons: Array<{ text: string; click: () => void }> = [];

	createEl(_tag: string, options?: { text?: string }) {
		const button = { text: options?.text ?? '', click: () => {} };
		this.buttons.push(button);
		return {
			addEventListener: (_event: string, handler: () => void) => {
				button.click = handler;
			},
		};
	}
}

/** Records every notice so tests can assert on what the user was told. */
export class Notice {
	static instances: Notice[] = [];

	static get messages(): string[] {
		return Notice.instances.map(notice => notice.message);
	}

	static reset(): void {
		Notice.instances = [];
	}

	noticeEl = new FakeNoticeEl();

	constructor(public message: string, public timeout?: number) {
		Notice.instances.push(this);
	}

	hide(): void {}
}

export class Plugin {
	private data: unknown = null;

	constructor(public app: App, public manifest: unknown = { id: 'mini-manager' }) {}

	async loadData(): Promise<unknown> {
		return this.data;
	}

	async saveData(data: unknown): Promise<void> {
		this.data = JSON.parse(JSON.stringify(data));
	}

	addCommand = jest.fn();
	addSettingTab = jest.fn();
	addRibbonIcon = jest.fn();
}

// UI base classes: present so the plugin's modules can be imported, not exercised.
export class Modal {
	constructor(public app: App) {}
	open(): void {}
	close(): void {}
}

export class PluginSettingTab {
	constructor(public app: App, public plugin: Plugin) {}
}

export class Setting {}

export interface FakeResponseInit {
	status?: number;
	headers?: Record<string, string>;
	json?: unknown;
	text?: string;
	arrayBuffer?: ArrayBuffer;
}

/** Builds what the real requestUrl resolves with, including its throwing `json` getter. */
export function makeResponse(init: FakeResponseInit = {}) {
	const body: ArrayBuffer =
		init.arrayBuffer ??
		new TextEncoder().encode(init.json !== undefined ? JSON.stringify(init.json) : init.text ?? '').buffer;
	return {
		status: init.status ?? 200,
		headers: init.headers ?? {},
		arrayBuffer: body,
		get text(): string {
			return new TextDecoder().decode(body);
		},
		get json(): unknown {
			return JSON.parse(new TextDecoder().decode(body));
		},
	};
}

/** The error the real requestUrl throws for status >= 400 when `throw` is not false. */
export class RequestUrlError extends Error {
	constructor(public status: number, public headers: Record<string, string>) {
		super(`Request failed, status ${status}`);
	}
}

export const requestUrl = jest.fn(async (_params: unknown): Promise<ReturnType<typeof makeResponse>> => makeResponse());
