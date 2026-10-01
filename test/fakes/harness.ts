// Builds the plugin's services against the in-memory vault. Tests import fakes from here
// rather than reaching into test/mocks directly.
import type { App } from 'obsidian';
import * as mock from '../mocks/obsidian';
import { DEFAULT_SETTINGS, MiniManagerSettings } from '../../src/settings/MiniManagerSettings';
import { LoggerService } from '../../src/services/LoggerService';
import { ACTIVE_STATES, FileStateService } from '../../src/services/FileStateService';
import { DownloadManager } from '../../src/services/DownloadManager';
import { OAuth2Service } from '../../src/services/OAuth2Service';
import { ValidationService } from '../../src/services/ValidationService';
import { MMFApiService } from '../../src/services/MMFApiService';
import { MMFDownloader } from '../../src/services/MMFDownloader';

export const PLUGIN_DIR = '.obsidian/plugins/mini-manager';
export const STATE_DIR = `${PLUGIN_DIR}/states`;
export const JOBS_DIR = `${PLUGIN_DIR}/jobs`;
export const LOG_FILE = `${PLUGIN_DIR}/debug.log`;

export interface TestEnv {
	app: App;
	adapter: mock.FakeAdapter;
	settings: MiniManagerSettings;
}

export async function createEnv(settings: Partial<MiniManagerSettings> = {}): Promise<TestEnv> {
	const fakeApp = new mock.App();
	await fakeApp.vault.adapter.mkdir(PLUGIN_DIR);
	return {
		app: fakeApp as unknown as App,
		adapter: fakeApp.vault.adapter,
		settings: { ...DEFAULT_SETTINGS, ...settings },
	};
}

export async function createStateServices(env: TestEnv) {
	const logger = new LoggerService(env.app, PLUGIN_DIR);
	const fileState = new FileStateService(env.app, logger, PLUGIN_DIR);
	await fileState.init();
	const downloadManager = new DownloadManager(fileState);
	await downloadManager.init();
	return { logger, fileState, downloadManager };
}

/** Simulates an Obsidian restart: fresh services over whatever is on disk. */
export const restartStateServices = createStateServices;

export async function createServices(env: TestEnv) {
	const { logger, fileState, downloadManager } = await createStateServices(env);
	const oauth2 = new OAuth2Service(env.settings, logger, async () => {});
	const api = new MMFApiService(env.settings, logger, oauth2);
	const validation = new ValidationService(env.app, env.settings, fileState);
	const downloader = new MMFDownloader(env.app, env.settings, logger, oauth2, api, validation, fileState, downloadManager, PLUGIN_DIR);
	return { logger, fileState, downloadManager, oauth2, api, validation, downloader };
}

/** A stored OAuth token as it sits in settings.oauthToken. */
export function oauthToken(options: { expired?: boolean; accessToken?: string } = {}): string {
	const now = Math.floor(Date.now() / 1000);
	return JSON.stringify({
		access_token: options.accessToken ?? 'test-access-token',
		token_type: 'Bearer',
		expires_in: 3600,
		created_at: options.expired ? now - 7200 : now,
	});
}

export function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitFor(condition: () => boolean | Promise<boolean>, describe: () => string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${describe()}`);
		await sleep(2);
	}
}

/** Ids in a state file, read straight from disk. Entries keep whatever format was written. */
export function readState(env: TestEnv, state: string): string[] {
	const content = env.adapter.files.get(`${STATE_DIR}/${state}.txt`);
	if (typeof content !== 'string') return [];
	return content.split('\n').filter(line => line !== '');
}

/** Every pipeline state whose file mentions the id; the `all` and `retried` ledgers are not states. */
export function statesOf(env: TestEnv, objectId: string): string[] {
	const states: string[] = [];
	for (const path of env.adapter.files.keys()) {
		if (!path.startsWith(`${STATE_DIR}/`)) continue;
		const state = path.substring(STATE_DIR.length + 1).replace(/\.txt$/, '');
		if (state === 'all' || state === 'retried') continue;
		if (readState(env, state).some(line => line === objectId || line.startsWith(`${objectId}:`))) {
			states.push(state);
		}
	}
	return states.sort();
}

/**
 * Waits for the pipeline to finish with an object, successfully or not, and returns the
 * state(s) it ended in.
 */
export async function waitForSettled(env: TestEnv, objectId: string, timeoutMs?: number): Promise<string[]> {
	const isSettled = () => {
		const states = statesOf(env, objectId);
		return states.length > 0 && !states.some(state => ACTIVE_STATES.includes(state));
	};
	await waitFor(
		isSettled,
		() => `object ${objectId} to leave the pipeline (stuck in: ${statesOf(env, objectId).join(', ') || 'no state'})`,
		timeoutMs
	);
	// The job record is updated just after the final state move; let that land.
	await sleep(15);
	return statesOf(env, objectId);
}

/** Paths of everything under a vault folder, relative to it. */
export function filesUnder(env: TestEnv, folder: string): string[] {
	return [...env.adapter.files.keys()]
		.filter(path => path.startsWith(`${folder}/`))
		.map(path => path.substring(folder.length + 1))
		.sort();
}

export function readText(env: TestEnv, path: string): string {
	const content = env.adapter.files.get(path);
	if (content === undefined) throw new Error(`No such file in fake vault: ${path}`);
	return typeof content === 'string' ? content : new TextDecoder().decode(content);
}

export const notices = (): string[] => mock.Notice.messages;
