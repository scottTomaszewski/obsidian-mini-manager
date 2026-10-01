import { FileStateService } from '../../../src/services/FileStateService';
import type { DownloadJob } from '../../../src/services/DownloadManager';
import { makeObject } from '../../fixtures/mmfObjects';
import { JOBS_DIR, PLUGIN_DIR, STATE_DIR, TestEnv, createEnv, createStateServices, readState, restartStateServices } from '../../fakes/harness';

function makeJob(id: string, status: DownloadJob['status'] = '00_queued'): DownloadJob {
	return { id, object: makeObject({ id }), status, progress: 0, progressMessage: '' };
}

describe('FileStateService', () => {
	let env: TestEnv;
	let fileState: FileStateService;

	beforeEach(async () => {
		env = await createEnv();
		({ fileState } = await createStateServices(env));
	});

	test('init creates the state and jobs folders', async () => {
		expect(env.adapter.folders.has(STATE_DIR)).toBe(true);
		expect(env.adapter.folders.has(JOBS_DIR)).toBe(true);
	});

	describe('state files', () => {
		test('add appends an id once, one per line', async () => {
			await fileState.add('00_queued', '1');
			await fileState.add('00_queued', '2');
			await fileState.add('00_queued', '1');

			expect(env.adapter.files.get(`${STATE_DIR}/00_queued.txt`)).toBe('1\n2\n');
		});

		test('add accepts numeric ids and ignores empty ones', async () => {
			await fileState.add('00_queued', 42);
			await fileState.add('00_queued', '');

			expect(await fileState.getAll('00_queued')).toEqual(['42']);
		});

		test('short state names resolve to the numbered state files', async () => {
			await fileState.add('queued', '1');

			expect(readState(env, '00_queued')).toEqual(['1']);
			expect(await fileState.getAll('00_queued')).toEqual(['1']);
		});

		test('getAll of a state with no file is empty', async () => {
			expect(await fileState.getAll('80_completed')).toEqual([]);
		});

		test('addAll adds every new id in one write', async () => {
			await fileState.add('all', '1');
			await fileState.addAll('all', ['1', 2, '', '3']);

			expect(await fileState.getAll('all')).toEqual(['1', '2', '3']);
		});

		test('remove drops only the given id', async () => {
			await fileState.addAll('00_queued', ['1', '2', '3']);
			await fileState.remove('00_queued', '2');

			expect(await fileState.getAll('00_queued')).toEqual(['1', '3']);
		});

		test('bulkRemove drops the ids from each listed state', async () => {
			await fileState.addAll('00_queued', ['1', '2']);
			await fileState.addAll('80_completed', ['2', '3']);
			await fileState.bulkRemove(['00_queued', '80_completed'], ['2']);

			expect(await fileState.getAll('00_queued')).toEqual(['1']);
			expect(await fileState.getAll('80_completed')).toEqual(['3']);
		});

		test('move takes an id out of one state and into another', async () => {
			await fileState.addAll('00_queued', ['1', '2']);
			await fileState.move('00_queued', '10_validating', '1');

			expect(await fileState.getAll('00_queued')).toEqual(['2']);
			expect(await fileState.getAll('10_validating')).toEqual(['1']);
		});

		test('getStateCounts reports how many ids each state holds', async () => {
			await fileState.addAll('00_queued', ['1', '2']);
			await fileState.add('80_completed', '3');
			await fileState.add('failure_auth', '4');

			expect(await fileState.getStateCounts()).toEqual({ queued: 2, completed: 1, failure_auth: 1 });
		});
	});

	describe('job files', () => {
		test('saveJob and getJob round-trip a job', async () => {
			const job = makeJob('1');
			await fileState.saveJob(job);

			expect(await fileState.getJob('1')).toEqual(job);
		});

		test('getJob is null for a missing or corrupt job file', async () => {
			await env.adapter.write(`${JOBS_DIR}/2.json`, '{ not json');

			expect(await fileState.getJob('1')).toBeNull();
			expect(await fileState.getJob('2')).toBeNull();
		});

		test('removeJob deletes the job file and tolerates a missing one', async () => {
			await fileState.saveJob(makeJob('1'));
			await fileState.removeJob('1');
			await fileState.removeJob('1');

			expect(await fileState.getAllJobFileIds()).toEqual([]);
		});

		test('requeueActiveJobs queues in-flight jobs and drops their job files', async () => {
			await fileState.saveJob(makeJob('1', '70_downloading'));
			await fileState.saveJob(makeJob('2', '30_preparing'));

			const requeued = await fileState.requeueActiveJobs();

			expect(requeued.sort()).toEqual(['1', '2']);
			expect(await fileState.getAll('00_queued')).toEqual(['1', '2']);
			expect(await fileState.getAllJobFileIds()).toEqual([]);
		});
	});

	describe('one state per object', () => {
		test('adding an id to a pipeline state takes it out of the one it was in', async () => {
			await fileState.add('00_queued', '1');
			await fileState.add('failure_auth', '1');

			expect(await fileState.getAll('00_queued')).toEqual([]);
			expect(await fileState.getAll('failure_auth')).toEqual(['1']);
			expect(readState(env, '00_queued')).toEqual([]);
			expect(readState(env, 'failure_auth')).toEqual(['1']);
		});

		test('getState is the pipeline state an id is in', async () => {
			await fileState.add('00_queued', '1');
			await fileState.move('00_queued', '10_validating', '1');

			expect(fileState.getState('1')).toBe('10_validating');
			expect(fileState.getState('2')).toBeUndefined();
		});

		test('the `all` ledger is kept alongside the pipeline state', async () => {
			await fileState.add('all', '1');
			await fileState.add('00_queued', '1');

			expect(await fileState.getAll('all')).toEqual(['1']);
			expect(fileState.getState('1')).toBe('00_queued');
		});

		test('clearState takes ids out of whichever state they are in', async () => {
			await fileState.add('40_prepared', '1');
			await fileState.add('failure_auth', '2');
			await fileState.add('00_queued', '3');

			await fileState.clearState(['1', '2']);

			expect(fileState.getState('1')).toBeUndefined();
			expect(fileState.getState('2')).toBeUndefined();
			expect(fileState.getState('3')).toBe('00_queued');
		});

		test('concurrent adds to one state are all kept', async () => {
			await Promise.all([fileState.add('00_queued', '1'), fileState.add('00_queued', '2')]);

			expect((await fileState.getAll('00_queued')).sort()).toEqual(['1', '2']);
			expect(readState(env, '00_queued').sort()).toEqual(['1', '2']);
		});

		test('concurrent moves out of one state all take effect', async () => {
			await fileState.addAll('50_downloading_images', ['1', '2']);

			await Promise.all([
				fileState.move('50_downloading_images', '60_images_downloaded', '1'),
				fileState.move('50_downloading_images', '60_images_downloaded', '2'),
			]);

			expect(readState(env, '50_downloading_images')).toEqual([]);
			expect(readState(env, '60_images_downloaded').sort()).toEqual(['1', '2']);
		});

		// A task that finishes after its job was cancelled must not put the job back into
		// the pipeline.
		test('move does nothing, and says so, when the id is not in the source state', async () => {
			await fileState.add('cancelled', '1');

			expect(await fileState.move('10_validating', '20_validated', '1')).toBe(false);
			expect(await fileState.getAll('20_validated')).toEqual([]);
			expect(fileState.getState('1')).toBe('cancelled');
		});

		test('move reports that it moved the id', async () => {
			await fileState.add('10_validating', '1');

			expect(await fileState.move('10_validating', '20_validated', '1')).toBe(true);
		});

		test('moveAcrossStates moves the id from whichever listed state holds it', async () => {
			await fileState.add('30_preparing', '1');

			expect(await fileState.moveAcrossStates(['00_queued', '30_preparing'], 'cancelled', '1')).toBe(true);
			expect(fileState.getState('1')).toBe('cancelled');
		});

		test('moveAcrossStates does not invent an entry for an id that was in none of the states', async () => {
			expect(await fileState.moveAcrossStates(['00_queued', '10_validating'], 'cancelled', '1')).toBe(false);
			expect(await fileState.getAll('cancelled')).toEqual([]);
		});

		test('requeueActiveJobs leaves finished jobs alone', async () => {
			await fileState.saveJob(makeJob('1', '80_completed'));
			await fileState.add('80_completed', '1');
			await fileState.saveJob(makeJob('2', 'failed'));
			await fileState.add('failure_auth', '2');

			expect(await fileState.requeueActiveJobs()).toEqual([]);
			expect(await fileState.getAll('00_queued')).toEqual([]);
			expect(fileState.getState('1')).toBe('80_completed');
			expect(fileState.getState('2')).toBe('failure_auth');
		});
	});

	describe('loading state from disk', () => {
		const writeState = (state: string, content: string) => env.adapter.write(`${STATE_DIR}/${state}.txt`, content);

		test('state written by one session is there in the next', async () => {
			await fileState.addAll('00_queued', ['1', '2']);
			await fileState.add('80_completed', '3');

			const next = (await restartStateServices(env)).fileState;

			expect(await next.getAll('00_queued')).toEqual(['1', '2']);
			expect(next.getState('3')).toBe('80_completed');
		});

		// Older versions wrote `id:message` lines into failure_unknown next to bare ids.
		test('legacy `id:message` lines are read as ids and the file is cleaned up', async () => {
			await writeState('failure_unknown', '1:API request failed: boom\n1\n2:other: thing\n');

			const next = (await restartStateServices(env)).fileState;

			expect(await next.getAll('failure_unknown')).toEqual(['1', '2']);
			expect(readState(env, 'failure_unknown')).toEqual(['1', '2']);
		});

		// Older versions could leave an id in several state files at once, most often a
		// failure state and `80_completed`: nothing ever took ids out of the failure files.
		describe('an id found in both a failure state and completed', () => {
			beforeEach(async () => {
				await writeState('80_completed', '1\n2\n');
				await writeState('failure_auth', '1\n');
			});

			test('is completed if its job record says it completed', async () => {
				await fileState.saveJob(makeJob('1', '80_completed'));

				const next = (await restartStateServices(env)).fileState;

				expect(next.getState('1')).toBe('80_completed');
				expect(readState(env, '80_completed')).toEqual(['1', '2']);
				expect(readState(env, 'failure_auth')).toEqual([]);
			});

			test('is failed if its job record says it failed', async () => {
				await fileState.saveJob(makeJob('1', 'failed'));

				const next = (await restartStateServices(env)).fileState;

				expect(next.getState('1')).toBe('failure_auth');
				expect(readState(env, '80_completed')).toEqual(['2']);
			});

			test('is failed, so that it gets retried, if there is no job record to settle it', async () => {
				const next = (await restartStateServices(env)).fileState;

				expect(next.getState('1')).toBe('failure_auth');
				expect(readState(env, '80_completed')).toEqual(['2']);
				expect(readState(env, 'failure_auth')).toEqual(['1']);
			});
		});

		// Versions before 0.0.22 wrote `queued.txt`, `completed.txt` and so on, and a file
		// sync tool can leave conflict copies behind.
		test('files this version does not write are ignored and left as they are', async () => {
			await writeState('80_completed', '1\n2\n3\n4\n');
			await writeState('completed', '1\n');
			await writeState('queued', '2\n');
			await writeState('failed', '3\n');
			await writeState('80_completed.sync-conflict-20250101', '4\n9\n');

			const next = (await restartStateServices(env)).fileState;

			expect(await next.getAll('80_completed')).toEqual(['1', '2', '3', '4']);
			expect(await next.getAll('00_queued')).toEqual([]);
			expect(next.getState('9')).toBeUndefined();
			expect(await next.getStateCounts()).toEqual({ completed: 4 });
			expect(readState(env, 'completed')).toEqual(['1']);
			expect(readState(env, 'queued')).toEqual(['2']);
			expect(readState(env, 'failed')).toEqual(['3']);
			expect(readState(env, '80_completed.sync-conflict-20250101')).toEqual(['4', '9']);
		});

		test('an id found in both a failure state and cancelled is kept as failed', async () => {
			await writeState('cancelled', '1\n');
			await writeState('failure_auth', '1\n');

			const next = (await restartStateServices(env)).fileState;

			expect(next.getState('1')).toBe('failure_auth');
		});

		test('an id found in an active state and anywhere else is kept as active', async () => {
			await writeState('80_completed', '1\n');
			await writeState('failure_unknown', '1\n');
			await writeState('40_prepared', '1\n');
			await writeState('00_queued', '1\n');

			const next = (await restartStateServices(env)).fileState;

			expect(next.getState('1')).toBe('00_queued');
			expect(readState(env, '40_prepared')).toEqual([]);
			expect(readState(env, 'failure_unknown')).toEqual([]);
			expect(readState(env, '80_completed')).toEqual([]);
		});

		test('the lock folder older versions used is removed', async () => {
			await env.adapter.mkdir(`${PLUGIN_DIR}/locks/00_queued.lock`);

			await restartStateServices(env);

			expect(await env.adapter.exists(`${PLUGIN_DIR}/locks`)).toBe(false);
		});
	});

	describe('writing state to disk', () => {
		test('a move writes the state gaining the id before the state losing it', async () => {
			await fileState.add('00_queued', '1');
			const write = jest.spyOn(env.adapter, 'write');

			await fileState.move('00_queued', '10_validating', '1');

			expect(write.mock.calls.map(([path]) => path)).toEqual([
				`${STATE_DIR}/10_validating.txt`,
				`${STATE_DIR}/00_queued.txt`,
			]);
		});

		test('a failed write does not fail the change, and is made good by the next one', async () => {
			jest.spyOn(env.adapter, 'write').mockRejectedValueOnce(new Error('EBUSY: resource busy or locked'));

			await fileState.add('00_queued', '1');
			expect(fileState.getState('1')).toBe('00_queued');
			expect(readState(env, '00_queued')).toEqual([]);

			await fileState.add('00_queued', '2');
			expect(readState(env, '00_queued')).toEqual(['1', '2']);
		});

		test('nothing is written once the service has been closed', async () => {
			await fileState.add('00_queued', '1');

			fileState.close();
			await fileState.add('00_queued', '2');
			await fileState.move('00_queued', '10_validating', '1');

			expect(readState(env, '00_queued')).toEqual(['1']);
			expect(readState(env, '10_validating')).toEqual([]);
		});
	});
});
