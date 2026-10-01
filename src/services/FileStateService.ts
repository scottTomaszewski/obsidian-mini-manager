import { App, normalizePath } from 'obsidian';
import { DownloadJob } from './DownloadManager';
import { LoggerService } from './LoggerService';

const STATE_PREFIX_MAP: { [key: string]: string } = {
    'queued': '00_queued',
    'validating': '10_validating',
    'validated': '20_validated',
    'preparing': '30_preparing',
    'prepared': '40_prepared',
    'downloading_images': '50_downloading_images',
    'images_downloaded': '60_images_downloaded',
    'downloading': '70_downloading', // This is for downloading files
    'completed': '80_completed'
};

/** The states an object passes through while it is being downloaded, in order. */
export const ACTIVE_STATES = [
	'00_queued',
	'10_validating',
	'20_validated',
	'30_preparing',
	'40_prepared',
	'50_downloading_images',
	'60_images_downloaded',
	'70_downloading',
];

export const COMPLETED_STATE = '80_completed';
export const CANCELLED_STATE = 'cancelled';

/** State files that record ids without saying where they are in the pipeline. */
const LEDGERS = new Set(['all', 'retried']);

export function isFailureState(state: string): boolean {
	return state.startsWith('failure_');
}

function isPipelineState(state: string): boolean {
	return ACTIVE_STATES.includes(state) || state === COMPLETED_STATE || state === CANCELLED_STATE || isFailureState(state);
}

/**
 * Tracks which state every object is in.
 *
 * The in-memory maps are the source of truth: an object is in at most one pipeline state,
 * plus any number of ledgers. Each state is mirrored to `states/<state>.txt`, one id per
 * line, through a single write queue so that concurrent changes cannot overwrite each other.
 */
export class FileStateService {
	private app: App;
	private logger: LoggerService;
	private stateDir: string;
	private jobsDir: string;
	private legacyLockDir: string;
	/** Ids per state file, in the order they were added. */
	private idsByState: Map<string, Set<string>> = new Map();
	/** The one pipeline state each id is in. */
	private stateById: Map<string, string> = new Map();
	private dirtyStates: Set<string> = new Set();
	private writes: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(app: App, logger: LoggerService, pluginDir: string) {
		this.app = app;
		this.logger = logger;
		this.stateDir = normalizePath(`${pluginDir}/states`);
		this.jobsDir = normalizePath(`${pluginDir}/jobs`);
		this.legacyLockDir = normalizePath(`${pluginDir}/locks`);
	}

	public async init(): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!await adapter.exists(this.stateDir)) {
			this.logger.info("Creating state directory...");
			await adapter.mkdir(this.stateDir);
		}
		if (!await adapter.exists(this.jobsDir)) {
			this.logger.info("Creating jobs directory...");
			await adapter.mkdir(this.jobsDir);
		}
		// Older versions locked state files with folders here.
		if (await adapter.exists(this.legacyLockDir)) {
			await adapter.rmdir(this.legacyLockDir, true);
		}
		await this.load();
	}

	private getActualStateName(state: string): string {
		return STATE_PREFIX_MAP[state] || state;
	}

	private getStateFilePath(state: string): string {
		return normalizePath(`${this.stateDir}/${state}.txt`);
	}

	private getJobFilePath(objectId: string): string {
		return normalizePath(`${this.jobsDir}/${objectId}.json`);
	}

	/**
	 * Reads the state files. Files written by older versions may list an id in several
	 * states, or as `id:message`; both are tidied up here and written back. Files this
	 * version does not write (pre-0.0.22 names such as `queued.txt`, sync conflict copies)
	 * are left alone.
	 */
	private async load(): Promise<void> {
		const adapter = this.app.vault.adapter;
		this.idsByState.clear();
		this.stateById.clear();

		const linesByState = new Map<string, string[]>();
		const stateFiles = await adapter.list(this.stateDir);
		for (const stateFile of stateFiles.files) {
			const fileName = stateFile.split('/').pop() ?? '';
			if (!fileName.endsWith('.txt')) continue;
			const state = fileName.slice(0, -'.txt'.length);
			if (!LEDGERS.has(state) && !isPipelineState(state)) continue;

			const content = await adapter.read(stateFile);
			linesByState.set(state, content.split('\n').map(line => line.trim()).filter(line => line !== ''));
		}

		const listedIn = new Map<string, string[]>();
		for (const [state, lines] of linesByState) {
			if (LEDGERS.has(state)) continue;
			for (const line of lines) {
				const id = this.idFromLine(line);
				const states = listedIn.get(id) ?? [];
				states.push(state);
				listedIn.set(id, states);
			}
		}
		for (const [id, states] of listedIn) {
			this.stateById.set(id, await this.settleState(id, states));
		}

		for (const [state, lines] of linesByState) {
			const ids = new Set<string>();
			for (const line of lines) {
				const id = this.idFromLine(line);
				if (LEDGERS.has(state) || this.stateById.get(id) === state) {
					ids.add(id);
				}
			}
			this.idsByState.set(state, ids);
			if (ids.size !== lines.length || lines.some(line => !ids.has(line))) {
				this.dirtyStates.add(state);
			}
		}

		await this.flush();
	}

	private idFromLine(line: string): string {
		const separator = line.indexOf(':');
		return separator === -1 ? line : line.substring(0, separator).trim();
	}

	/**
	 * Picks the one state for an id that the files list in several. Unfinished work wins
	 * (earliest stage, so nothing is skipped). Between failed and completed the job record
	 * decides, since older versions never took ids out of the failure files; with no record,
	 * failed wins so that the object is retried rather than assumed done.
	 */
	private async settleState(objectId: string, states: string[]): Promise<string> {
		if (states.length === 1) return states[0];

		const preferred = states.reduce((best, state) => this.loadPriority(state) < this.loadPriority(best) ? state : best);
		if (isFailureState(preferred) && states.includes(COMPLETED_STATE)) {
			const job = await this.getJob(objectId);
			if (job?.status === COMPLETED_STATE) return COMPLETED_STATE;
		}
		return preferred;
	}

	private loadPriority(state: string): number {
		const stage = ACTIVE_STATES.indexOf(state);
		if (stage !== -1) return stage;
		if (isFailureState(state)) return 100;
		return state === CANCELLED_STATE ? 150 : 200;
	}

	private idsIn(state: string): Set<string> {
		let ids = this.idsByState.get(state);
		if (!ids) {
			ids = new Set();
			this.idsByState.set(state, ids);
		}
		return ids;
	}

	/** Puts an id in a state, taking it out of the pipeline state it was in. */
	private place(state: string, objectId: string): void {
		const ids = this.idsIn(state);
		if (ids.has(objectId)) return;

		// Mark the destination first: files are written in this order, and after a crash an id
		// in two files is put right on load, while an id in neither is lost.
		this.dirtyStates.add(state);
		if (!LEDGERS.has(state)) {
			this.take(objectId);
			this.stateById.set(objectId, state);
		}
		ids.add(objectId);
	}

	/** Takes an id out of its pipeline state, if it is in one. */
	private take(objectId: string): void {
		const state = this.stateById.get(objectId);
		if (state === undefined) return;
		this.idsIn(state).delete(objectId);
		this.stateById.delete(objectId);
		this.dirtyStates.add(state);
	}

	private takeFromLedger(state: string, objectId: string): void {
		if (this.idsIn(state).delete(objectId)) {
			this.dirtyStates.add(state);
		}
	}

	/**
	 * Writes every changed state file. Resolves once this call's changes are on disk, or
	 * have failed to get there: memory stays the source of truth, and a state that could not
	 * be written is written again with the next change.
	 */
	private flush(): Promise<void> {
		this.writes = this.writes.then(() => this.writeDirtyStates()).catch(() => undefined);
		return this.writes;
	}

	/**
	 * Stops writing to disk. For when the plugin unloads: a task that is still finishing
	 * must not overwrite the files of the instance that replaces this one.
	 */
	public close(): void {
		this.closed = true;
	}

	private async writeDirtyStates(): Promise<void> {
		if (this.closed) return;
		const states = Array.from(this.dirtyStates);
		this.dirtyStates.clear();
		for (let i = 0; i < states.length; i++) {
			const ids = Array.from(this.idsIn(states[i]));
			const content = ids.length > 0 ? ids.join('\n') + '\n' : '';
			try {
				await this.app.vault.adapter.write(this.getStateFilePath(states[i]), content);
			} catch (e) {
				states.slice(i).forEach(state => this.dirtyStates.add(state));
				this.logger.error(`Failed to write state file '${states[i]}': ${e.message}`);
				throw e;
			}
		}
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

	public async getAllJobFileIds(): Promise<string[]> {
		if (!await this.app.vault.adapter.exists(this.jobsDir)) {
			return [];
		}

		const jobFiles = await this.app.vault.adapter.list(this.jobsDir);
		const ids = new Set<string>();
		for (const jobFile of jobFiles.files) {
			const objectId = jobFile.split('/').pop()?.replace('.json', '');
			if (objectId) {
				ids.add(objectId);
			}
		}
		return Array.from(ids);
	}

	/**
	 * Puts every job that has not finished back in the queue. Completed, cancelled and
	 * failed objects are left where they are.
	 */
	public async requeueActiveJobs(): Promise<string[]> {
		const requeuedIds: string[] = [];
		const jobIds = await this.getAllJobFileIds();

		for (const objectId of jobIds) {
			const state = this.stateById.get(objectId);
			if (state !== undefined && !ACTIVE_STATES.includes(state)) continue;

			this.place('00_queued', objectId);
			this.place('all', objectId);
			await this.removeJob(objectId); // delete job json file
			requeuedIds.push(objectId);
		}

		await this.flush();
		return requeuedIds;
	}

	public async removeJob(objectId: string): Promise<void> {
		const filePath = this.getJobFilePath(objectId);
		if (await this.app.vault.adapter.exists(filePath)) {
			await this.app.vault.adapter.remove(filePath);
		}
	}

	public async bulkRemoveJobs(ids: string[]): Promise<void> {
		for (const id of ids) {
			await this.removeJob(id);
		}
	}

	/** The pipeline state an object is in, if any. */
	public getState(objectId: string | number): string | undefined {
		return this.stateById.get(String(objectId).trim());
	}

	/** Names of the failure states that currently exist. */
	public getFailureStates(): string[] {
		return Array.from(this.idsByState.keys()).filter(isFailureState);
	}

	/** Every object that is in a failure state. */
	public getFailedIds(): string[] {
		return Array.from(this.stateById.entries()).filter(([, state]) => isFailureState(state)).map(([id]) => id);
	}

	public async add(state: string, objectId: string | number): Promise<void> {
		if (!objectId) return; // Do not add empty objectIds
		this.place(this.getActualStateName(state), String(objectId).trim());
		await this.flush();
	}

	public async addAll(state: string, objectIds: Array<string | number>): Promise<void> {
		if (!objectIds || objectIds.length === 0) return;

		for (const objectId of objectIds) {
			if (!objectId) continue; // skip empty values
			this.place(this.getActualStateName(state), String(objectId).trim());
		}
		await this.flush();
	}

	public async remove(state: string, objectId: string | number): Promise<void> {
		await this.bulkRemove([state], [objectId]);
	}

	public async bulkRemove(states: string[], objectIds: (string | number)[]): Promise<void> {
		for (const state of states.map(s => this.getActualStateName(s))) {
			for (const objectId of objectIds) {
				const id = String(objectId).trim();
				if (LEDGERS.has(state)) {
					this.takeFromLedger(state, id);
				} else if (this.stateById.get(id) === state) {
					this.take(id);
				}
			}
		}
		await this.flush();
	}

	/** Takes objects out of whichever pipeline state they are in. */
	public async clearState(objectIds: (string | number)[]): Promise<void> {
		for (const objectId of objectIds) {
			this.take(String(objectId).trim());
		}
		await this.flush();
	}

	/**
	 * Moves an object from one state to another. Does nothing if the object is not in
	 * `fromState` (it was cancelled or re-queued in the meantime, say).
	 * @returns whether the object was moved.
	 */
	public async move(fromState: string, toState: string, objectId: string | number): Promise<boolean> {
		return this.moveAcrossStates([fromState], toState, objectId);
	}

	/**
	 * Moves an object into `toState` if it is currently in any of `fromStates`.
	 * @returns whether the object was moved.
	 */
	public async moveAcrossStates(fromStates: string[], toState: string, objectId: string | number): Promise<boolean> {
		if (!objectId) return false;
		const id = String(objectId).trim();
		const current = this.stateById.get(id);
		if (current === undefined || !fromStates.map(s => this.getActualStateName(s)).includes(current)) {
			return false;
		}
		this.place(this.getActualStateName(toState), id);
		await this.flush();
		return true;
	}

	public async getAll(state: string): Promise<string[]> {
		return Array.from(this.idsByState.get(this.getActualStateName(state)) ?? []);
	}

	public async getStateCounts(): Promise<Record<string, number>> {
		const counts: Record<string, number> = {};
		for (const [state, ids] of this.idsByState) {
			// Report under the short name, e.g. 'queued' for '00_queued'.
			const label = Object.keys(STATE_PREFIX_MAP).find(key => STATE_PREFIX_MAP[key] === state) ?? state;
			counts[label] = ids.size;
		}
		return counts;
	}
}
