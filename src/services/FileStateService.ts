import { App, normalizePath } from 'obsidian';
import { DownloadJob } from './DownloadManager';
import { LoggerService } from './LoggerService';

export class FileStateService {
	private static instance: FileStateService;
	private app: App;
	private logger: LoggerService;
	private stateDir: string;
	private jobsDir: string;
	private lockDir: string;
	private readonly retryDelay = 50;
	private readonly lockTimeout = 10000; // 10 seconds

	private constructor(app: App, logger: LoggerService) {
		this.app = app;
		this.logger = logger;
		const pluginDir = this.app.vault.configDir + '/plugins/mini-manager';
		this.stateDir = normalizePath(`${pluginDir}/states`);
		this.jobsDir = normalizePath(`${pluginDir}/jobs`);
		this.lockDir = normalizePath(`${pluginDir}/locks`);
	}

	public static getInstance(app?: App, logger?: LoggerService): FileStateService {
		if (!FileStateService.instance) {
			if (!app || !logger) {
				throw new Error("App and Logger must be provided on first instantiation of FileStateService.");
			}
			FileStateService.instance = new FileStateService(app, logger);
		}
		return FileStateService.instance;
	}

	public async init(): Promise<void> {
		if (!await this.app.vault.adapter.exists(this.stateDir)) {
			this.logger.info("Creating state directory...");
			await this.app.vault.adapter.mkdir(this.stateDir);
		}
		if (!await this.app.vault.adapter.exists(this.jobsDir)) {
			this.logger.info("Creating jobs directory...");
			await this.app.vault.adapter.mkdir(this.jobsDir);
		}
		if (!await this.app.vault.adapter.exists(this.lockDir)) {
			this.logger.info("Creating lock directory...");
			await this.app.vault.adapter.mkdir(this.lockDir);
		}
	}

	private getStateFilePath(state: string): string {
		return normalizePath(`${this.stateDir}/${state}.txt`);
	}

	private getJobFilePath(objectId: string): string {
		return normalizePath(`${this.jobsDir}/${objectId}.json`);
	}

	private getLockFilePath(state: string): string {
		return normalizePath(`${this.lockDir}/${state}.lock`);
	}

	private async acquireLock(state: string): Promise<void> {
		const lockDir = this.getLockFilePath(state);
		const startTime = Date.now();

		while (true) {
			try {
				await this.app.vault.adapter.mkdir(lockDir);
				break; // Lock acquired
			} catch (e) {
				if (Date.now() - startTime > this.lockTimeout) {
					this.logger.error(`Could not acquire lock for state '${state}' within ${this.lockTimeout}ms. Lock file: ${lockDir}`);
					throw new Error(`Could not acquire lock for state '${state}'.`);
				}
				await new Promise(resolve => setTimeout(resolve, this.retryDelay));
			}
		}
	}

	private async releaseLock(state: string): Promise<void> {
		const lockDir = this.getLockFilePath(state);
		try {
			// The true flag means recursive, which will delete the directory even if it's not empty.
			await this.app.vault.adapter.rmdir(lockDir, true);
		} catch (e) {
			// Ignore errors, such as if the directory doesn't exist.
			if (!e.message.contains("no such file or directory")) {
				this.logger.warn(`Unexpected error releasing lock for state '${state}': ${e.message}`);
			}
		}
	}

	private async getIds(state: string): Promise<string[]> {
		const filePath = this.getStateFilePath(state);
		if (!await this.app.vault.adapter.exists(filePath)) {
			return [];
		}
		const content = await this.app.vault.adapter.read(filePath);
		return content.split('\n').map(id => id.trim()).filter(id => id !== '');
	}

	private async writeIds(state: string, ids: string[]): Promise<void> {
		const filePath = this.getStateFilePath(state);
		const content = ids.length > 0 ? ids.join('\n') + '\n' : '';
		await this.app.vault.adapter.write(filePath, content);
	}

	public async saveJob(job: DownloadJob): Promise<void> {
		const filePath = this.getJobFilePath(job.id);
		await this.app.vault.adapter.write(filePath, JSON.stringify(job, null, 2));
	}

	public async getJob(objectId: string): Promise<DownloadJob | null> {
		const filePath = this.getJobFilePath(objectId);
		if (!await this.app.vault.adapter.exists(filePath)) {
			return null;
		}
		const content = await this.app.vault.adapter.read(filePath);
		try {
			return JSON.parse(content) as DownloadJob;
		} catch (e) {
			this.logger.error(`Failed to parse job file for ${objectId}: ${e.message}`);
			return null;
		}
	}

	public async removeJob(objectId: string): Promise<void> {
		const filePath = this.getJobFilePath(objectId);
		if (await this.app.vault.adapter.exists(filePath)) {
			await this.app.vault.adapter.remove(filePath);
		}
	}

	public async add(state: string, objectId: string): Promise<void> {
		await this.acquireLock(state);
		try {
			const ids = await this.getIds(state);
			if (!ids.includes(objectId)) {
				ids.push(objectId);
				await this.writeIds(state, ids);
			}
		} finally {
			await this.releaseLock(state);
		}
	}

	public async remove(state: string, objectId: string): Promise<void> {
		await this.acquireLock(state);
		try {
			let ids = await this.getIds(state);
			const initialLength = ids.length;
			ids = ids.filter(id => id !== objectId);
			if (ids.length < initialLength) {
				await this.writeIds(state, ids);
			}
		} finally {
			await this.releaseLock(state);
		}
	}

	public async move(fromState: string, toState: string, objectId: string): Promise<void> {
		// Acquire locks in a consistent order to prevent deadlocks
		const sortedStates = [fromState, toState].sort();
		await this.acquireLock(sortedStates[0]);
		await this.acquireLock(sortedStates[1]);

		try {
			// Remove from source
			let fromIds = await this.getIds(fromState);
			if (fromIds.includes(objectId)) {
				fromIds = fromIds.filter(id => id !== objectId);
				await this.writeIds(fromState, fromIds);
			}

			// Add to destination
			let toIds = await this.getIds(toState);
			if (!toIds.includes(objectId)) {
				toIds.push(objectId);
				await this.writeIds(toState, toIds);
			}
		} finally {
			// Release locks in reverse order
			await this.releaseLock(sortedStates[1]);
			await this.releaseLock(sortedStates[0]);
		}
	}

	public async getAll(state: string): Promise<string[]> {
		// This read can be dirty, but for safety, we lock.
		await this.acquireLock(state);
		try {
			return await this.getIds(state);
		} finally {
			await this.releaseLock(state);
		}
	}

	public async pop(state: string): Promise<string | null> {
		await this.acquireLock(state);
		try {
			const ids = await this.getIds(state);
			if (ids.length === 0) {
				return null;
			}
			const poppedId = ids.shift();
			await this.writeIds(state, ids);
			return poppedId ?? null;
		} finally {
			await this.releaseLock(state);
		}
	}

	public async getAllJobIds(): Promise<string[]> {
		const allIds = new Set<string>();
		const stateFiles = await this.app.vault.adapter.list(this.stateDir);
		for (const stateFile of stateFiles.files) {
			const state = stateFile.split('/').pop()?.replace('.txt', '');
			// we lock the state file to prevent reading it while it's being written to.
			if (state) {
				await this.acquireLock(state);
				try {
					const ids = await this.getIds(state);
					ids.forEach(id => allIds.add(id));
				} finally {
					await this.releaseLock(state);
				}
			}
		}
		return Array.from(allIds);
	}

	public async addUnknownFailure(objectId: string, error: Error): Promise<void> {
		const state = 'failure_unknown';
		await this.acquireLock(state);
		try {
			const filePath = this.getStateFilePath(state);
			const sanitizedError = error.message.replace(/(\r\n|\n|\r)/gm, " ");
			const line = `${objectId}:${sanitizedError}\n`;
			
			let content = '';
			if (await this.app.vault.adapter.exists(filePath)) {
				content = await this.app.vault.adapter.read(filePath);
			}
			content += line;
			await this.app.vault.adapter.write(filePath, content);

		} finally {
			await this.releaseLock(state);
		}
	}
}

