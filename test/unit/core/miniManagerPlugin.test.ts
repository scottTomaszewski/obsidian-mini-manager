import type { PluginManifest } from 'obsidian';
import MiniManagerPlugin from '../../../src/core/MiniManagerPlugin';
import { DEFAULT_SETTINGS, MiniManagerSettings } from '../../../src/settings/MiniManagerSettings';
import { FakeMmf } from '../../fakes/fakeMmf';
import { OBJECT_FOLDER, OBJECT_ID, makeObject } from '../../fixtures/mmfObjects';
import { JOBS_DIR, STATE_DIR, TestEnv, createEnv, notices, oauthToken, readState, sleep, statesOf, waitFor, waitForSettled } from '../../fakes/harness';

const MANIFEST = { id: 'mini-manager', name: 'Mini Manager', version: '0.0.0' } as PluginManifest;

describe('MiniManagerPlugin', () => {
	let env: TestEnv;
	let mmf: FakeMmf;
	const bare = makeObject({ images: [], files: { total_count: 0, items: [] } });

	beforeEach(async () => {
		env = await createEnv();
		mmf = new FakeMmf().install();
	});

	async function load(saved?: Partial<MiniManagerSettings>): Promise<MiniManagerPlugin> {
		const plugin = new MiniManagerPlugin(env.app, MANIFEST);
		if (saved) await plugin.saveData(saved);
		await plugin.onload();
		return plugin;
	}

	test('loads with default settings on a fresh vault', async () => {
		const plugin = await load();

		expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
		expect(env.adapter.folders.has(STATE_DIR)).toBe(true);
	});

	test('saved settings override the defaults', async () => {
		const plugin = await load({ mmfApiKey: 'abc', downloadPath: 'Minis' });

		expect(plugin.settings).toEqual({ ...DEFAULT_SETTINGS, mmfApiKey: 'abc', downloadPath: 'Minis' });
	});

	test('registers its commands, settings tab and ribbon icon', async () => {
		const plugin = await load();

		const commandIds = (plugin.addCommand as jest.Mock).mock.calls.map(([command]) => command.id);
		expect(commandIds).toEqual([
			'search-mmf-objects',
			'open-download-manager',
			'resume-downloads',
			'retry-failed-downloads',
			'start-bulk-download',
			'requeue-active-jobs',
			'validate-all-models',
		]);
		expect(plugin.addSettingTab).toHaveBeenCalledTimes(1);
		expect(plugin.addRibbonIcon).toHaveBeenCalledTimes(1);
	});

	test('asks for an API key when none is set', async () => {
		await load();

		expect(notices()).toContain('Please set your MyMiniFactory API key in the settings.');
	});

	test('a download interrupted mid-flight is re-queued and finished on the next load', async () => {
		mmf.object(bare);
		await env.adapter.mkdir(STATE_DIR);
		await env.adapter.write(`${STATE_DIR}/70_downloading.txt`, `${OBJECT_ID}\n`);

		await load({ oauthToken: oauthToken() });

		expect(readState(env, '70_downloading')).toEqual([]);
		expect(await waitForSettled(env, OBJECT_ID)).toEqual(['80_completed']);
		expect(await env.adapter.exists(`${OBJECT_FOLDER}/README.md`)).toBe(true);
	});

	test('a job that was never queued is queued and finished on the next load', async () => {
		mmf.object(bare);
		await env.adapter.mkdir(JOBS_DIR);
		await env.adapter.write(
			`${JOBS_DIR}/${OBJECT_ID}.json`,
			JSON.stringify({ id: OBJECT_ID, object: bare, status: 'pending', progress: 0, progressMessage: 'Queued' })
		);

		await load({ oauthToken: oauthToken() });

		expect(await waitForSettled(env, OBJECT_ID)).toEqual(['80_completed']);
	});

	test('a completed job with no state entry is left alone on load', async () => {
		await env.adapter.mkdir(JOBS_DIR);
		await env.adapter.write(
			`${JOBS_DIR}/${OBJECT_ID}.json`,
			JSON.stringify({ id: OBJECT_ID, object: bare, status: '80_completed', progress: 100, progressMessage: 'Completed' })
		);

		await load({ oauthToken: oauthToken() });
		await sleep(20);

		expect(statesOf(env, OBJECT_ID)).toEqual([]);
		expect(mmf.requests).toEqual([]);
	});

	test('nothing is said on load when there is nothing to do', async () => {
		await load({ mmfApiKey: 'abc', oauthToken: oauthToken({ expired: true }) });
		await sleep(20);

		expect(notices()).toEqual([]);
	});

	test('logging in through the settings tab retries objects that failed on auth, and saves the token', async () => {
		mmf.object(bare);
		await env.adapter.mkdir(STATE_DIR);
		await env.adapter.write(`${STATE_DIR}/failure_auth.txt`, `${OBJECT_ID}\n`);
		const plugin = await load({ oauthToken: oauthToken({ expired: true }) });

		await plugin.oauth2Service.exchangeCodeForToken('https://www.myminifactory.com/oauth/callback#access_token=fresh&expires_in=3600');

		await waitFor(() => statesOf(env, OBJECT_ID).join() === '80_completed', () => `the retry to complete (in: ${statesOf(env, OBJECT_ID)})`);
		expect(JSON.parse(((await plugin.loadData()) as MiniManagerSettings).oauthToken).access_token).toBe('fresh');
	});

	test('unloading stops the downloader', async () => {
		mmf.object(bare);
		const plugin = await load({ oauthToken: oauthToken() });

		plugin.onunload();
		await plugin.downloader.downloadObject(OBJECT_ID);
		await sleep(20);

		expect(mmf.requests).toEqual([]);
	});

	// Toggling the plugin off and on starts a second instance over the same files.
	test('an unloaded plugin no longer writes state', async () => {
		const plugin = await load({ oauthToken: oauthToken() });

		plugin.onunload();
		await plugin.fileStateService.add('00_queued', OBJECT_ID);

		expect(readState(env, '00_queued')).toEqual([]);
	});

	test('keeps its state in the plugin folder named after its id, wherever it is installed from', async () => {
		const plugin = new MiniManagerPlugin(env.app, { ...MANIFEST, dir: '.obsidian/plugins/some-other-folder' });
		await plugin.onload();

		expect(env.adapter.folders.has(STATE_DIR)).toBe(true);
		expect(env.adapter.folders.has('.obsidian/plugins/some-other-folder/states')).toBe(false);
	});
});
