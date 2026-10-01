import JSZip from 'jszip';
import { MMFDownloader } from '../../../src/services/MMFDownloader';
import { DownloadManager } from '../../../src/services/DownloadManager';
import { FileStateService } from '../../../src/services/FileStateService';
import { OAuth2Service } from '../../../src/services/OAuth2Service';
import type { MiniManagerSettings } from '../../../src/settings/MiniManagerSettings';
import type { MMFObject } from '../../../src/models/MMFObject';
import { FakeMmf, LOGIN_REDIRECT, heldResponse } from '../../fakes/fakeMmf';
import { IMAGE_1_URL, IMAGE_2_URL, OBJECT_FOLDER, OBJECT_ID, STL_URL, ZIP_URL, bytes, makeObject } from '../../fixtures/mmfObjects';
import {
	PLUGIN_DIR,
	TestEnv,
	createEnv,
	createServices,
	filesUnder,
	notices,
	oauthToken,
	readState,
	readText,
	sleep,
	statesOf,
	waitFor,
	waitForSettled,
} from '../../fakes/harness';

describe('MMFDownloader', () => {
	let env: TestEnv;
	let mmf: FakeMmf;
	let downloader: MMFDownloader;
	let downloadManager: DownloadManager;
	let fileState: FileStateService;
	let oauth2: OAuth2Service;

	/** A logged-in user with direct file downloads on, unless overridden. */
	async function setup(settings: Partial<MiniManagerSettings> = {}): Promise<void> {
		env = await createEnv({ oauthToken: oauthToken(), ...settings });
		mmf = new FakeMmf().install();
		({ downloader, downloadManager, fileState, oauth2 } = await createServices(env));
	}

	/** Serves makeObject() along with its two images and its STL. */
	function serveGoblin(overrides: Partial<MMFObject> = {}): void {
		mmf.object(makeObject(overrides))
			.url(IMAGE_1_URL, { arrayBuffer: bytes('jpg-bytes'), headers: { 'content-type': 'image/jpeg' } })
			.url(IMAGE_2_URL, { arrayBuffer: bytes('png-bytes'), headers: { 'content-type': 'image/png' } })
			.url(STL_URL, { arrayBuffer: bytes('solid goblin'), headers: { 'content-type': 'application/octet-stream' } });
	}

	/** An object with nothing to fetch beyond its metadata. */
	function bare(id: number, name: string): MMFObject {
		return makeObject({ id, name, images: [], files: { total_count: 0, items: [] } });
	}

	const settled = (objectId: string) => waitForSettled(env, objectId);

	/** Leaves makeObject() sitting in the queue with downloads paused. */
	async function queuedWhilePaused(): Promise<void> {
		downloader.pauseDownloads();
		await downloadManager.addJob(makeObject());
		await fileState.add('00_queued', OBJECT_ID);
	}

	/** What the user does after an auth failure: log in again through the settings tab. */
	async function logInAgain(): Promise<void> {
		await oauth2.exchangeCodeForToken('https://www.myminifactory.com/oauth/callback#access_token=fresh-token&expires_in=3600');
	}

	const authNotices = () => notices().filter(message => message.includes('authentication expired'));

	async function download(objectId: string = OBJECT_ID): Promise<string[]> {
		await downloader.downloadObject(objectId);
		return settled(objectId);
	}

	describe('a successful download', () => {
		beforeEach(async () => {
			await setup();
			serveGoblin();
		});

		test('ends in the completed state with the job marked complete', async () => {
			expect(await download()).toEqual(['80_completed']);
			expect(downloadManager.getJob(OBJECT_ID)).toMatchObject({ status: '80_completed', progress: 100 });
			expect(readState(env, 'all')).toEqual([OBJECT_ID]);
		});

		test('lays the object out under <download path>/<designer>/<name>', async () => {
			await download();

			expect(filesUnder(env, 'MyMiniFactory')).toEqual([
				'Test Designer/Goblin Warband/README.md',
				'Test Designer/Goblin Warband/files/goblin.stl',
				'Test Designer/Goblin Warband/images/image_1.jpg',
				'Test Designer/Goblin Warband/images/image_2.png',
				'Test Designer/Goblin Warband/mmf-metadata.json',
			]);
			expect(readText(env, `${OBJECT_FOLDER}/files/goblin.stl`)).toBe('solid goblin');
		});

		test('writes the API object to mmf-metadata.json', async () => {
			await download();

			expect(JSON.parse(readText(env, `${OBJECT_FOLDER}/mmf-metadata.json`))).toEqual(makeObject());
		});

		test('writes a README with frontmatter pointing at the first local image', async () => {
			await download();

			const readme = readText(env, `${OBJECT_FOLDER}/README.md`);
			expect(readme.startsWith('---\n')).toBe(true);
			expect(readme).toContain('name: "Goblin Warband"');
			expect(readme).toContain('designer: "Test Designer"');
			expect(readme).toContain(`main_image: "${OBJECT_FOLDER}/images/image_1.jpg"`);
			expect(readme).toContain('- goblin.stl (2.0 KB)');
		});

		test('passes the OAuth access token when fetching files', async () => {
			await download();

			expect(mmf.requestsTo(STL_URL)[0].url).toBe(`${STL_URL}?access_token=test-access-token`);
		});

		test('downloading it again validates what is on disk instead of fetching anything', async () => {
			await download();
			mmf.requests = [];

			expect(await download()).toEqual(['80_completed']);
			expect(mmf.requests).toEqual([]);
		});

		test('downloading it again after a file went missing fetches the object afresh', async () => {
			await download();
			await env.adapter.remove(`${OBJECT_FOLDER}/files/goblin.stl`);
			mmf.requests = [];

			expect(await download()).toEqual(['80_completed']);
			expect(mmf.objectRequests(OBJECT_ID)).toHaveLength(1);
			expect(readText(env, `${OBJECT_FOLDER}/files/goblin.stl`)).toBe('solid goblin');
		});
	});

	test('a zip is saved and its contents extracted alongside it', async () => {
		await setup();
		const zip = new JSZip();
		zip.file('readme.txt', 'thanks for downloading');
		zip.file('supported/goblin_a.stl', 'solid goblin_a');
		serveGoblin({
			files: { total_count: 1, items: [{ id: 900002, filename: 'goblins.zip', size: 4096, download_url: ZIP_URL }] },
		});
		mmf.url(ZIP_URL, { arrayBuffer: await zip.generateAsync({ type: 'arraybuffer' }), headers: { 'content-type': 'application/zip' } });

		expect(await download()).toEqual(['80_completed']);
		expect(filesUnder(env, `${OBJECT_FOLDER}/files`)).toEqual(['goblins.zip', 'readme.txt', 'supported/goblin_a.stl']);
		expect(readText(env, `${OBJECT_FOLDER}/files/supported/goblin_a.stl`)).toBe('solid goblin_a');
	});

	describe('a zip that cannot be extracted', () => {
		const zipObject = {
			files: { total_count: 1, items: [{ id: 900002, filename: 'goblins.zip', size: 4096, download_url: ZIP_URL }] },
		};
		const corrupt = { arrayBuffer: bytes('this is not a zip archive'), headers: { 'content-type': 'application/zip' } };

		test('fails the object instead of completing it', async () => {
			await setup();
			serveGoblin(zipObject);
			mmf.url(ZIP_URL, corrupt);

			expect(await download()).toEqual(['failure_unknown']);
			expect(downloadManager.getJob(OBJECT_ID)?.error).toContain('Failed to extract goblins.zip');
		});

		test('does not keep the zip, so a retry fetches it again and extracts it', async () => {
			await setup();
			serveGoblin(zipObject);
			const zip = new JSZip();
			zip.file('goblin_a.stl', 'solid goblin_a');
			const good = { arrayBuffer: await zip.generateAsync({ type: 'arraybuffer' }), headers: { 'content-type': 'application/zip' } };
			mmf.url(ZIP_URL, [corrupt, good]);

			await download();
			expect(await env.adapter.exists(`${OBJECT_FOLDER}/files/goblins.zip`)).toBe(false);

			await downloader.retryFailed();

			expect(await settled(OBJECT_ID)).toEqual(['80_completed']);
			expect(readText(env, `${OBJECT_FOLDER}/files/goblin_a.stl`)).toBe('solid goblin_a');
		});
	});

	describe('download settings', () => {
		test('images are skipped when "Download Images" is off', async () => {
			await setup({ downloadImages: false });
			serveGoblin();

			expect(await download()).toEqual(['80_completed']);
			expect(mmf.requestsTo(IMAGE_1_URL)).toEqual([]);
			expect(filesUnder(env, OBJECT_FOLDER)).toEqual(['README.md', 'files/goblin.stl', 'mmf-metadata.json']);
		});

		test('files are skipped when "Download Files" is off', async () => {
			await setup({ downloadFiles: false });
			serveGoblin();

			expect(await download()).toEqual(['80_completed']);
			expect(mmf.requestsTo(STL_URL)).toEqual([]);
			expect(filesUnder(env, OBJECT_FOLDER)).toEqual(['README.md', 'images/image_1.jpg', 'images/image_2.png', 'mmf-metadata.json']);
		});

		test('objects are saved under the configured download path', async () => {
			await setup({ downloadPath: 'Minis/MMF' });
			serveGoblin();

			await download();

			expect(await env.adapter.exists('Minis/MMF/Test Designer/Goblin Warband/files/goblin.stl')).toBe(true);
		});

		test('characters that are not allowed in folder names are replaced', async () => {
			await setup();
			serveGoblin({ name: 'Goblins: "The Warband" / Part 1?' });

			await download();

			expect(await env.adapter.exists('MyMiniFactory/Test Designer/Goblins_ _The Warband_ _ Part 1_/README.md')).toBe(true);
		});
	});

	describe('when the server rejects the credentials', () => {
		beforeEach(async () => {
			await setup();
			mmf.objectResponse(OBJECT_ID, { status: 401, json: { error: 'invalid_token' } });
		});

		test('the object goes to failure_auth and its job is marked failed', async () => {
			expect(await download()).toEqual(['failure_auth']);
			expect(downloadManager.getJob(OBJECT_ID)).toMatchObject({ status: 'failed' });
			expect(downloadManager.getJob(OBJECT_ID)?.error).toContain('Authentication failed');
		});

		test('downloads pause and the user is told to re-authenticate', async () => {
			await download();

			expect(downloader.isPausedState()).toBe(true);
			expect(notices()).toContain('MyMiniFactory authentication expired. Please re-authenticate in the settings.');
		});

		test('the token the server rejected is discarded', async () => {
			await download();

			expect(env.settings.oauthToken).toBe('');
			expect(oauth2.isAuthenticated()).toBe(false);
		});

		test('nothing is written to the download folder', async () => {
			await download();

			expect(await env.adapter.exists('MyMiniFactory')).toBe(false);
		});

	});

	test('after an auth failure the rest of the queue waits, and the user is told once', async () => {
		await setup({ maxConcurrentLightTasks: 1 });
		mmf.objectResponse(OBJECT_ID, { status: 401, json: { error: 'invalid_token' } });
		mmf.object(bare(2, 'Two'));

		await downloader.downloadObject(OBJECT_ID);
		await downloader.downloadObject('2');
		await settled(OBJECT_ID);
		await sleep(20);

		expect(statesOf(env, '2')).toEqual(['00_queued']);
		expect(mmf.objectRequests('2')).toEqual([]);
		expect(authNotices()).toHaveLength(1);
	});

	// The reported bug: the token is stored, so the plugin thinks it is logged in, but it has
	// expired. This used to end with a placeholder saved to Unknown/Object <id> and marked
	// complete, never to be retried.
	describe('when the stored token has expired', () => {
		beforeEach(async () => {
			await setup({ oauthToken: oauthToken({ expired: true }) });
			serveGoblin();
			await downloader.downloadObject(OBJECT_ID);
			await waitFor(() => downloader.isPausedState(), () => 'downloads to pause');
		});

		test('downloads pause before anything is attempted and the object stays queued', async () => {
			expect(statesOf(env, OBJECT_ID)).toEqual(['00_queued']);
			expect(mmf.requests).toEqual([]);
			expect(await env.adapter.exists('MyMiniFactory')).toBe(false);
		});

		test('the user is told to re-authenticate', async () => {
			expect(authNotices()).toHaveLength(1);
		});

		test('resuming without logging in pauses again', async () => {
			await downloader.resumeDownloads();
			await waitFor(() => downloader.isPausedState(), () => 'downloads to pause');

			expect(statesOf(env, OBJECT_ID)).toEqual(['00_queued']);
			expect(mmf.requests).toEqual([]);
		});

		test('the object is downloaded once the user has logged in again and resumed', async () => {
			await logInAgain();
			await downloader.resumeDownloads();

			expect(await settled(OBJECT_ID)).toEqual(['80_completed']);
			expect(filesUnder(env, 'MyMiniFactory/Unknown')).toEqual([]);
		});
	});

	test('without a login the object waits in the queue, whatever is being downloaded', async () => {
		await setup({ oauthToken: '', downloadFiles: false, downloadImages: false });
		serveGoblin();

		await downloader.downloadObject(OBJECT_ID);
		await waitFor(() => downloader.isPausedState(), () => 'downloads to pause');

		expect(statesOf(env, OBJECT_ID)).toEqual(['00_queued']);
		expect(mmf.requests).toEqual([]);
		expect(authNotices()).toHaveLength(1);
	});

	describe('failures', () => {
		test('an object the API cannot find fails with its status code and leaves nothing behind', async () => {
			await setup();

			expect(await download()).toEqual(['failure_code_404']);
			expect(downloadManager.getJob(OBJECT_ID)).toMatchObject({ status: 'failed' });
			expect(await env.adapter.exists('MyMiniFactory')).toBe(false);
		});

		test('a server error fails the object with its status code', async () => {
			await setup({ maxRetries: 0 });
			mmf.objectResponse(OBJECT_ID, { status: 503, text: 'Service Unavailable' });

			expect(await download()).toEqual(['failure_code_503']);
		});

		test('an error that is not an HTTP status fails the object as unknown, with the message on the job', async () => {
			await setup({ maxRetries: 0 });
			mmf.objectResponse(OBJECT_ID, new Error('socket hang up'));

			expect(await download()).toEqual(['failure_unknown']);
			expect(readState(env, 'failure_unknown')).toEqual([OBJECT_ID]);
			expect(downloadManager.getJob(OBJECT_ID)?.error).toContain('socket hang up');
		});

		test('a 403 on a file fails that object only: downloads carry on', async () => {
			await setup();
			serveGoblin();
			mmf.url(STL_URL, { status: 403 });
			mmf.object(bare(2, 'Two'));

			expect(await download()).toEqual(['failure_code_403']);
			expect(downloader.isPausedState()).toBe(false);
			expect(await download('2')).toEqual(['80_completed']);
		});

		test('a 401 on a file is an auth failure and pauses downloads', async () => {
			await setup();
			serveGoblin();
			mmf.url(STL_URL, { status: 401 });

			expect(await download()).toEqual(['failure_auth']);
			expect(downloader.isPausedState()).toBe(true);
		});

		// Otherwise every resume would fetch the object again only to be refused again.
		test('a 401 on a file discards the token, so nothing is attempted until the user logs in', async () => {
			await setup();
			serveGoblin();
			mmf.url(STL_URL, { status: 401 });
			await download();
			mmf.requests = [];

			await downloader.resumeDownloads();
			await waitFor(() => downloader.isPausedState(), () => 'downloads to pause');

			expect(oauth2.isAuthenticated()).toBe(false);
			expect(statesOf(env, OBJECT_ID)).toEqual(['00_queued']);
			expect(mmf.requests).toEqual([]);
		});

		// A 403 is about this object (private, not purchased), not about the login.
		test('a 403 from the API fails that object only: downloads carry on', async () => {
			await setup();
			mmf.objectResponse(OBJECT_ID, { status: 403, json: { error: 'access_denied' } });
			mmf.object(bare(2, 'Two'));

			expect(await download()).toEqual(['failure_code_403']);
			expect(downloader.isPausedState()).toBe(false);
			expect(oauth2.isAuthenticated()).toBe(true);
			expect(await download('2')).toEqual(['80_completed']);
		});

		test('a web page served in place of an image fails that object only', async () => {
			await setup();
			serveGoblin();
			mmf.url(IMAGE_2_URL, LOGIN_REDIRECT);

			expect(await download()).toEqual(['failure_unknown']);
			expect(downloader.isPausedState()).toBe(false);
			expect(await env.adapter.exists(`${OBJECT_FOLDER}/images/image_2.png`)).toBe(false);
		});

		test('a login page served in place of a file is an auth failure and is not saved', async () => {
			await setup();
			serveGoblin();
			mmf.url(STL_URL, LOGIN_REDIRECT);

			expect(await download()).toEqual(['failure_auth']);
			expect(downloader.isPausedState()).toBe(true);
			expect(await env.adapter.exists(`${OBJECT_FOLDER}/files/goblin.stl`)).toBe(false);
		});

		test('an image that cannot be fetched fails the object with its status code', async () => {
			await setup();
			serveGoblin();
			mmf.url(IMAGE_2_URL, { status: 404 });

			expect(await download()).toEqual(['failure_code_404']);
		});
	});

	describe('retrying', () => {
		/** Fails makeObject() with a 401, then lets the server accept the next attempt. */
		async function failWithAuthError(): Promise<void> {
			await setup();
			serveGoblin();
			mmf.objectResponse(OBJECT_ID, [{ status: 401, json: { error: 'invalid_token' } }, { json: makeObject() }]);
			expect(await download()).toEqual(['failure_auth']);
		}

		test('resuming after logging in again retries the objects that failed on auth', async () => {
			await failWithAuthError();

			await logInAgain();
			await downloader.resumeDownloads();

			expect(await settled(OBJECT_ID)).toEqual(['80_completed']);
			expect(downloadManager.getJob(OBJECT_ID)).toMatchObject({ status: '80_completed' });
			expect(downloadManager.getJob(OBJECT_ID)?.error).toBeUndefined();
		});

		test('resuming leaves objects that failed for other reasons where they are', async () => {
			await setup();
			expect(await download()).toEqual(['failure_code_404']);
			mmf.requests = [];

			await downloader.resumeDownloads();
			await sleep(20);

			expect(statesOf(env, OBJECT_ID)).toEqual(['failure_code_404']);
			expect(mmf.requests).toEqual([]);
		});

		test('retryFailed re-queues every failed object, whatever the failure', async () => {
			await setup({ maxRetries: 0 });
			mmf.objectResponse('2', new Error('socket hang up'));
			expect(await download('1')).toEqual(['failure_code_404']);
			expect(await download('2')).toEqual(['failure_unknown']);
			mmf.object(bare(1, 'One')).object(bare(2, 'Two'));

			expect(await downloader.retryFailed()).toBe(2);

			expect(await settled('1')).toEqual(['80_completed']);
			expect(await settled('2')).toEqual(['80_completed']);
		});

		test('retryFailed with nothing failed does nothing', async () => {
			await setup();

			expect(await downloader.retryFailed()).toBe(0);
		});

		test('requesting a failed object again retries it', async () => {
			await setup();
			expect(await download()).toEqual(['failure_code_404']);
			serveGoblin();

			expect(await download()).toEqual(['80_completed']);
		});

		test('retrying a failed object through bulk download leaves it in a single state', async () => {
			await setup();
			mmf.object(bare(1, 'One'));
			await downloadManager.addJob(bare(1, 'One'));
			await downloadManager.updateJob('1', 'failed', 100, 'Failed', 'Authentication failed');
			await fileState.add('failure_auth', '1');
			await env.adapter.write(`${PLUGIN_DIR}/bulk-downloads.txt`, '1');

			await downloader.startBulkDownload();

			expect(await settled('1')).toEqual(['80_completed']);
		});

		// When a file cannot be fetched the plugin asks the user to put it in place by hand.
		test('retrying keeps files the user has put in place by hand, and completes with them', async () => {
			await setup();
			serveGoblin();
			mmf.url(STL_URL, { status: 403 });
			expect(await download()).toEqual(['failure_code_403']);
			expect(await env.adapter.exists(`${OBJECT_FOLDER}/files/MANUAL_DOWNLOAD_REQUIRED.md`)).toBe(true);
			await env.adapter.write(`${OBJECT_FOLDER}/files/goblin.stl`, 'downloaded by hand');

			expect(await downloader.retryFailed()).toBe(1);

			expect(await settled(OBJECT_ID)).toEqual(['80_completed']);
			expect(readText(env, `${OBJECT_FOLDER}/files/goblin.stl`)).toBe('downloaded by hand');
			expect(mmf.requestsTo(STL_URL)).toHaveLength(1);
			expect(await env.adapter.exists(`${OBJECT_FOLDER}/files/MANUAL_DOWNLOAD_REQUIRED.md`)).toBe(false);
		});

		describe('redownload, as used by the validation results', () => {
			test('deletes what is on disk and downloads the object again', async () => {
				await setup();
				serveGoblin();
				await download();
				await env.adapter.write(`${OBJECT_FOLDER}/files/goblin.stl`, 'corrupt');

				await downloader.redownload(OBJECT_ID, OBJECT_FOLDER);

				expect(await settled(OBJECT_ID)).toEqual(['80_completed']);
				expect(readText(env, `${OBJECT_FOLDER}/files/goblin.stl`)).toBe('solid goblin');
			});

			test('leaves an object that is being downloaded right now alone', async () => {
				await setup();
				const held = heldResponse({ arrayBuffer: bytes('solid goblin'), headers: { 'content-type': 'application/octet-stream' } });
				serveGoblin();
				mmf.url(STL_URL, held.response);
				await downloader.downloadObject(OBJECT_ID);
				await waitFor(() => mmf.requestsTo(STL_URL).length === 1, () => 'the file request');

				await downloader.redownload(OBJECT_ID, OBJECT_FOLDER);

				expect(statesOf(env, OBJECT_ID)).toEqual(['70_downloading']);
				expect(await env.adapter.exists(`${OBJECT_FOLDER}/mmf-metadata.json`)).toBe(true);

				held.release();
				expect(await settled(OBJECT_ID)).toEqual(['80_completed']);
			});
		});

		// An older version could leave a placeholder under Unknown/ and, after a later
		// successful attempt, the real download as well.
		test('a stale placeholder folder is removed when the object also has a real, valid download', async () => {
			await setup();
			serveGoblin();
			await download();
			const placeholderFolder = `MyMiniFactory/Unknown/Object ${OBJECT_ID}`;
			await env.adapter.mkdir(placeholderFolder);
			await env.adapter.write(`${placeholderFolder}/README.md`, '---\nname: Object 12345\n---\n');
			await env.adapter.write(
				`${placeholderFolder}/mmf-metadata.json`,
				JSON.stringify({ id: OBJECT_ID, name: `Object ${OBJECT_ID}`, description: '', url: '', images: [], files: { total_count: 0, items: [] } })
			);
			mmf.requests = [];

			expect(await download()).toEqual(['80_completed']);
			expect(await env.adapter.exists(placeholderFolder)).toBe(false);
			expect(await env.adapter.exists(`${OBJECT_FOLDER}/files/goblin.stl`)).toBe(true);
			expect(mmf.requests).toEqual([]);
		});

		// Older versions saved a placeholder to Unknown/Object <id> when the API call failed
		// and marked it complete.
		test('a placeholder download left by an older version is replaced by the real object', async () => {
			await setup();
			serveGoblin();
			const placeholderFolder = `MyMiniFactory/Unknown/Object ${OBJECT_ID}`;
			await env.adapter.mkdir(`${placeholderFolder}/images`);
			await env.adapter.write(`${placeholderFolder}/README.md`, '---\nname: Object 12345\n---\n');
			await env.adapter.write(
				`${placeholderFolder}/mmf-metadata.json`,
				JSON.stringify({
					id: OBJECT_ID,
					name: `Object ${OBJECT_ID}`,
					description: 'Unable to retrieve object details from the API',
					url: `https://www.myminifactory.com/object/${OBJECT_ID}`,
					images: [],
					files: { total_count: 0, items: [] },
				})
			);
			await fileState.add('80_completed', OBJECT_ID);

			expect(await download()).toEqual(['80_completed']);
			expect(await env.adapter.exists(placeholderFolder)).toBe(false);
			expect(await env.adapter.exists(`${OBJECT_FOLDER}/files/goblin.stl`)).toBe(true);
		});
	});

	describe('queue control', () => {
		test('a download runs to completion without the queue being prompted again', async () => {
			await setup();
			serveGoblin();

			expect(await download()).toEqual(['80_completed']);
		});

		test('resumeDownloads works through ids already sitting in the queue', async () => {
			await setup();
			mmf.object(bare(1, 'One')).object(bare(2, 'Two'));
			await fileState.addAll('00_queued', ['1', '2']);

			await downloader.resumeDownloads();

			expect(await settled('1')).toEqual(['80_completed']);
			expect(await settled('2')).toEqual(['80_completed']);
		});

		test('more objects than there are slots all get downloaded', async () => {
			await setup({ maxConcurrentLightTasks: 2, maxConcurrentDownloads: 1 });
			const ids = ['1', '2', '3', '4', '5', '6', '7'];
			ids.forEach(id => mmf.object(bare(Number(id), `Object number ${id}`)));

			await Promise.all(ids.map(id => downloader.downloadObject(id)));

			for (const id of ids) {
				expect(await settled(id)).toEqual(['80_completed']);
			}
		});

		test('an object requested while paused is queued, and downloaded once downloads resume', async () => {
			await setup();
			serveGoblin();
			downloader.pauseDownloads();

			await downloader.downloadObject(OBJECT_ID);
			await sleep(20);

			expect(readState(env, '00_queued')).toEqual([OBJECT_ID]);
			expect(mmf.requests).toEqual([]);

			await downloader.resumeDownloads();

			expect(await settled(OBJECT_ID)).toEqual(['80_completed']);
		});

		test('requesting an object that is already in progress does not restart it', async () => {
			await setup();
			downloader.pauseDownloads();
			await downloadManager.addJob(makeObject());
			await fileState.add('30_preparing', OBJECT_ID);

			await downloader.downloadObject(OBJECT_ID);

			expect(statesOf(env, OBJECT_ID)).toEqual(['30_preparing']);
			expect(downloadManager.getJob(OBJECT_ID)?.object.name).toBe('Goblin Warband');
		});

		test('a job that is re-validated keeps the name of its object', async () => {
			await setup();
			serveGoblin();
			await download();

			await download();

			expect(downloadManager.getJob(OBJECT_ID)?.object.name).toBe('Goblin Warband');
		});

		test('cancelDownload moves a queued object to cancelled and forgets its job', async () => {
			await setup();
			await queuedWhilePaused();

			await downloader.cancelDownload(OBJECT_ID);

			expect(statesOf(env, OBJECT_ID)).toEqual(['cancelled']);
			expect(downloadManager.getJob(OBJECT_ID)).toBeUndefined();
			expect(notices()).toContain(`Download for ${OBJECT_ID} cancelled.`);
		});

		describe('cancelling a download that is in flight', () => {
			const stl = () => heldResponse({ arrayBuffer: bytes('solid goblin'), headers: { 'content-type': 'application/octet-stream' } });

			test('the object ends up cancelled and its file is not saved when the request returns', async () => {
				await setup();
				const held = stl();
				serveGoblin();
				mmf.url(STL_URL, held.response);
				await downloader.downloadObject(OBJECT_ID);
				await waitFor(() => mmf.requestsTo(STL_URL).length === 1, () => 'the file request');

				await downloader.cancelDownload(OBJECT_ID);
				held.release();
				await sleep(30);

				expect(statesOf(env, OBJECT_ID)).toEqual(['cancelled']);
				expect(await env.adapter.exists(`${OBJECT_FOLDER}/files/goblin.stl`)).toBe(false);
				expect(await env.adapter.exists(`${OBJECT_FOLDER}/README.md`)).toBe(false);
			});

			// The first attempt, finishing late, must not disarm cancellation of the second.
			test('an object cancelled, requested again and cancelled again stays cancelled', async () => {
				await setup();
				const first = stl();
				const second = stl();
				serveGoblin();
				mmf.url(STL_URL, [first.response, second.response]);

				await downloader.downloadObject(OBJECT_ID);
				await waitFor(() => mmf.requestsTo(STL_URL).length === 1, () => 'the first file request');
				await downloader.cancelDownload(OBJECT_ID);

				await downloader.downloadObject(OBJECT_ID);
				await waitFor(() => mmf.requestsTo(STL_URL).length === 2, () => 'the second file request');
				first.release();
				await sleep(30);

				await downloader.cancelDownload(OBJECT_ID);
				second.release();
				await sleep(30);

				expect(statesOf(env, OBJECT_ID)).toEqual(['cancelled']);
				expect(await env.adapter.exists(`${OBJECT_FOLDER}/files/goblin.stl`)).toBe(false);
				expect(await env.adapter.exists(`${OBJECT_FOLDER}/README.md`)).toBe(false);
			});
		});

		test('a cancelled object can be requested again', async () => {
			await setup();
			serveGoblin();
			await queuedWhilePaused();
			await downloader.cancelDownload(OBJECT_ID);
			await downloader.resumeDownloads();

			expect(await download()).toEqual(['80_completed']);
		});

		test('shutdown stops anything further being started', async () => {
			await setup();
			serveGoblin();

			downloader.shutdown();
			await downloader.downloadObject(OBJECT_ID);
			await sleep(20);

			expect(mmf.requests).toEqual([]);
		});
	});

	describe('bulk download', () => {
		const BULK_FILE = `${PLUGIN_DIR}/bulk-downloads.txt`;

		test('downloads every id in the comma-separated bulk file', async () => {
			await setup();
			mmf.object(bare(1, 'One')).object(bare(2, 'Two'));
			await env.adapter.write(BULK_FILE, '1, 2,\n');

			await downloader.startBulkDownload();

			expect(await settled('1')).toEqual(['80_completed']);
			expect(await settled('2')).toEqual(['80_completed']);
		});

		test('skips ids that are already complete', async () => {
			await setup();
			mmf.object(bare(1, 'One'));
			await env.adapter.write(BULK_FILE, '1');
			await downloader.startBulkDownload();
			await settled('1');
			mmf.requests = [];

			await downloader.startBulkDownload();
			await sleep(20);

			expect(mmf.requests).toEqual([]);
			expect(statesOf(env, '1')).toEqual(['80_completed']);
		});

		test('tells the user when there is no bulk file', async () => {
			await setup();

			await downloader.startBulkDownload();

			expect(notices()).toEqual([`Bulk download file not found at ${BULK_FILE}`]);
		});
	});
});
