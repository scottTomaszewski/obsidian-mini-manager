import { DownloadJob, DownloadManager } from '../../../src/services/DownloadManager';
import { FileStateService } from '../../../src/services/FileStateService';
import { makeObject } from '../../fixtures/mmfObjects';
import { TestEnv, createEnv, createStateServices } from '../../fakes/harness';

describe('DownloadManager', () => {
	let env: TestEnv;
	let fileState: FileStateService;
	let downloadManager: DownloadManager;

	beforeEach(async () => {
		env = await createEnv();
		({ fileState, downloadManager } = await createStateServices(env));
	});

	test('addJob creates a pending job and persists it', async () => {
		const job = await downloadManager.addJob(makeObject({ id: 1 }));

		expect(job).toMatchObject({ id: '1', status: 'pending', progress: 0 });
		expect(downloadManager.getJob('1')).toBe(job);
		expect(await fileState.getJob('1')).toEqual(job);
	});

	test('updateJob changes status and progress, in memory and on disk', async () => {
		await downloadManager.addJob(makeObject({ id: 1 }));
		await downloadManager.updateJob('1', '30_preparing', 10, 'Preparing metadata...');

		const expected = { status: '30_preparing', progress: 10, progressMessage: 'Preparing metadata...' };
		expect(downloadManager.getJob('1')).toMatchObject(expected);
		expect(await fileState.getJob('1')).toMatchObject(expected);
	});

	test('updateJob records an error and a later update clears it', async () => {
		await downloadManager.addJob(makeObject({ id: 1 }));

		await downloadManager.updateJob('1', 'failed', 100, 'Failed', 'boom');
		expect(downloadManager.getJob('1')?.error).toBe('boom');

		await downloadManager.updateJob('1', '00_queued', 0, 'In queue...');
		expect(downloadManager.getJob('1')?.error).toBeUndefined();
	});

	test('updateJob picks up a job that only exists on disk', async () => {
		const job: DownloadJob = { id: '9', object: makeObject({ id: 9 }), status: 'pending', progress: 0, progressMessage: '' };
		await fileState.saveJob(job);

		await downloadManager.updateJob('9', '00_queued', 0, 'In queue...');

		expect(downloadManager.getJob('9')?.status).toBe('00_queued');
	});

	test('updateJob for an unknown job does nothing', async () => {
		await downloadManager.updateJob('404', '00_queued', 0, 'In queue...');

		expect(downloadManager.getJob('404')).toBeUndefined();
		expect(await fileState.getJob('404')).toBeNull();
	});

	test('updateJobObject swaps in the real object', async () => {
		await downloadManager.addJob({ id: '1', name: 'Object 1', description: '', url: '', images: [] });
		await downloadManager.updateJobObject('1', makeObject({ id: 1 }));

		expect(downloadManager.getJob('1')?.object.name).toBe('Goblin Warband');
		expect((await fileState.getJob('1'))?.object.name).toBe('Goblin Warband');
	});

	test('getJobs is sorted by object name', async () => {
		await downloadManager.addJob(makeObject({ id: 1, name: 'Zombie' }));
		await downloadManager.addJob(makeObject({ id: 2, name: 'Angel' }));

		expect(downloadManager.getJobs().map(job => job.object.name)).toEqual(['Angel', 'Zombie']);
	});

	test('subscribers hear about changes until they unsubscribe', async () => {
		const listener = jest.fn();
		downloadManager.subscribe(listener);

		await downloadManager.addJob(makeObject({ id: 1 }));
		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener.mock.calls[0][0]).toHaveLength(1);

		downloadManager.unsubscribe(listener);
		await downloadManager.updateJob('1', '00_queued', 0, 'In queue...');
		expect(listener).toHaveBeenCalledTimes(1);
	});

	test('a new instance loads the jobs persisted by the last one', async () => {
		await downloadManager.addJob(makeObject({ id: 1 }));

		const reloaded = new DownloadManager(fileState);
		await reloaded.init();

		expect(reloaded.getJob('1')).toMatchObject({ id: '1', status: 'pending' });
	});

	test('forgetJob drops the job record but leaves the object in its state', async () => {
		await downloadManager.addJob(makeObject({ id: 1 }));
		await fileState.add('cancelled', '1');

		await downloadManager.forgetJob('1');

		expect(downloadManager.getJob('1')).toBeUndefined();
		expect(await fileState.getJob('1')).toBeNull();
		expect(fileState.getState('1')).toBe('cancelled');
	});

	test('removeJob forgets the job but keeps the id in the `all` ledger', async () => {
		await downloadManager.addJob(makeObject({ id: 1 }));
		await fileState.add('00_queued', '1');

		await downloadManager.removeJob('1');

		expect(downloadManager.getJob('1')).toBeUndefined();
		expect(await fileState.getJob('1')).toBeNull();
		expect(await fileState.getAll('00_queued')).toEqual([]);
		expect(await fileState.getAll('all')).toEqual(['1']);
	});

	describe('clearing finished jobs', () => {
		beforeEach(async () => {
			await downloadManager.addJob(makeObject({ id: 1 }));
			await downloadManager.updateJob('1', '80_completed', 100, 'Completed');
			await fileState.add('80_completed', '1');

			await downloadManager.addJob(makeObject({ id: 2 }));
			await downloadManager.updateJob('2', 'failed', 100, 'Failed', 'boom');

			await downloadManager.addJob(makeObject({ id: 3 }));
			await downloadManager.updateJob('3', '00_queued', 0, 'In queue...');
			await fileState.add('00_queued', '3');
		});

		test('counts completed and failed jobs', () => {
			expect(downloadManager.getCompletedJobsCount()).toBe(1);
			expect(downloadManager.getFailedJobsCount()).toBe(1);
		});

		test('clearCompleted removes only completed jobs', async () => {
			await downloadManager.clearCompleted();

			expect(downloadManager.getJobs().map(job => job.id).sort()).toEqual(['2', '3']);
			expect(await fileState.getJob('1')).toBeNull();
			expect(await fileState.getAll('80_completed')).toEqual([]);
		});

		test('clearFailed removes only failed jobs', async () => {
			await downloadManager.clearFailed();

			expect(downloadManager.getJobs().map(job => job.id).sort()).toEqual(['1', '3']);
			expect(await fileState.getJob('2')).toBeNull();
		});
	});

	// Older versions left ids in the failure states with no job record.
	describe('failed objects with no job record', () => {
		beforeEach(async () => {
			await fileState.addAll('failure_auth', ['7', '8']);
			await downloadManager.addJob(makeObject({ id: 9 }));
			await downloadManager.updateJob('9', 'failed', 100, 'Failed', 'boom');
			await fileState.add('failure_unknown', '9');
		});

		test('are counted as failed', () => {
			expect(downloadManager.getFailedJobsCount()).toBe(3);
		});

		test('are cleared by clearFailed', async () => {
			await downloadManager.clearFailed();

			expect(downloadManager.getFailedJobsCount()).toBe(0);
			expect(await fileState.getAll('failure_auth')).toEqual([]);
			expect(await fileState.getAll('failure_unknown')).toEqual([]);
		});
	});

	describe('forgetting jobs in any state', () => {
		test('removeJob takes the id out of whichever pipeline state it is in', async () => {
			await downloadManager.addJob(makeObject({ id: 1 }));
			await fileState.add('40_prepared', '1');

			await downloadManager.removeJob('1');

			expect(await fileState.getAll('40_prepared')).toEqual([]);
		});

		test('clearFailed takes the ids out of the failure states', async () => {
			await downloadManager.addJob(makeObject({ id: 1 }));
			await downloadManager.updateJob('1', 'failed', 100, 'Failed', 'boom');
			await fileState.add('failure_auth', '1');

			await downloadManager.clearFailed();

			expect(await fileState.getAll('failure_auth')).toEqual([]);
		});
	});
});
