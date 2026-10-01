import { ValidationService } from '../../../src/services/ValidationService';
import { FileStateService } from '../../../src/services/FileStateService';
import type { MMFObject } from '../../../src/models/MMFObject';
import { LOGIN_REDIRECT } from '../../fakes/fakeMmf';
import { OBJECT_FOLDER, OBJECT_ID, makeObject } from '../../fixtures/mmfObjects';
import { TestEnv, createEnv, createStateServices } from '../../fakes/harness';

const README = '---\nname: Goblin Warband\n---\n\n# Goblin Warband\n';

describe('ValidationService', () => {
	let env: TestEnv;
	let fileState: FileStateService;
	let validation: ValidationService;

	beforeEach(async () => {
		env = await createEnv();
		({ fileState } = await createStateServices(env));
		validation = new ValidationService(env.app, env.settings, fileState);
	});

	/** Lays a finished download out on disk the way the downloader leaves it. */
	async function seedDownload(object: MMFObject, folder: string, files: Record<string, string> = {}): Promise<void> {
		const contents: Record<string, string> = {
			'mmf-metadata.json': JSON.stringify(object),
			'README.md': README,
			'images/image_1.jpg': 'jpg',
			'images/image_2.png': 'png',
			'files/goblin.stl': 'solid goblin',
			...files,
		};
		await env.adapter.mkdir(`${folder}/images`);
		await env.adapter.mkdir(`${folder}/files`);
		for (const [name, content] of Object.entries(contents)) {
			await env.adapter.write(`${folder}/${name}`, content);
		}
	}

	async function seedGoodAndBad(): Promise<void> {
		await seedDownload(makeObject({ id: 1, name: 'Good' }), 'MyMiniFactory/Test Designer/Good');
		await seedDownload(makeObject({ id: 2, name: 'Bad' }), 'MyMiniFactory/Test Designer/Bad');
		await env.adapter.remove('MyMiniFactory/Test Designer/Bad/README.md');
		await env.adapter.mkdir('MyMiniFactory/Test Designer/Not A Download');
	}

	describe('validateAndGetResult', () => {
		test('is null when nothing has been downloaded', async () => {
			await expect(validation.validateAndGetResult(OBJECT_ID)).resolves.toBeNull();
		});

		test('is null when no downloaded folder belongs to the object', async () => {
			await seedDownload(makeObject(), OBJECT_FOLDER);

			await expect(validation.validateAndGetResult('999')).resolves.toBeNull();
		});

		test('finds the object by the id in its metadata and passes a complete download', async () => {
			await seedDownload(makeObject(), OBJECT_FOLDER);

			await expect(validation.validateAndGetResult(OBJECT_ID)).resolves.toMatchObject({
				folderPath: OBJECT_FOLDER,
				isValid: true,
				errors: [],
			});
		});

		test('fails a download with a file missing', async () => {
			await seedDownload(makeObject(), OBJECT_FOLDER);
			await env.adapter.remove(`${OBJECT_FOLDER}/files/goblin.stl`);

			await expect(validation.validateAndGetResult(OBJECT_ID)).resolves.toMatchObject({
				isValid: false,
				errors: ['Missing file: goblin.stl'],
			});
		});

		test('fails a download with images missing', async () => {
			await seedDownload(makeObject(), OBJECT_FOLDER);
			await env.adapter.remove(`${OBJECT_FOLDER}/images/image_2.png`);

			await expect(validation.validateAndGetResult(OBJECT_ID)).resolves.toMatchObject({
				isValid: false,
				errors: ['Missing images. Expected 2, found 1.'],
			});
		});

		test('fails a zip that is really a saved login page', async () => {
			const object = makeObject({
				files: { total_count: 1, items: [{ id: 2, filename: 'goblins.zip', size: 10, download_url: 'https://example.com/2' }] },
			});
			await seedDownload(object, OBJECT_FOLDER, { 'files/goblins.zip': LOGIN_REDIRECT.text ?? '' });

			const result = await validation.validateAndGetResult(OBJECT_ID);

			expect(result?.errors).toEqual(['File goblins.zip is HTML content, not a valid file (possible login redirect).']);
		});

		test('does not expect images or files that the settings say not to download', async () => {
			env.settings.downloadImages = false;
			env.settings.downloadFiles = false;
			await seedDownload(makeObject(), OBJECT_FOLDER);
			await env.adapter.rmdir(`${OBJECT_FOLDER}/images`, true);
			await env.adapter.rmdir(`${OBJECT_FOLDER}/files`, true);

			await expect(validation.validateAndGetResult(OBJECT_ID)).resolves.toMatchObject({ isValid: true });
		});

		// Older versions saved one of these, marked complete, whenever the API call failed.
		test.each([
			['saved when the API call failed', { description: 'Unable to retrieve object details from the API', url: `https://www.myminifactory.com/object/${OBJECT_ID}` }],
			['saved before the object was fetched', { description: '', url: '' }],
		])('fails a folder holding only placeholder metadata (%s)', async (_kind, fields) => {
			const placeholder: MMFObject = {
				id: OBJECT_ID,
				name: `Object ${OBJECT_ID}`,
				images: [],
				files: { total_count: 0, items: [] },
				...fields,
			};
			const folder = `MyMiniFactory/Unknown/Object ${OBJECT_ID}`;
			await seedDownload(placeholder, folder);

			await expect(validation.validateAndGetResult(OBJECT_ID)).resolves.toMatchObject({
				folderPath: folder,
				isValid: false,
				errors: ['Placeholder only: the object was never fetched from MyMiniFactory.'],
			});
		});
	});

	describe('validate', () => {
		test('is empty when the download folder does not exist', async () => {
			await expect(validation.validate()).resolves.toEqual([]);
		});

		test('checks every downloaded object and records the valid ones as completed', async () => {
			await seedGoodAndBad();

			const results = await validation.validate();

			expect(results.map(result => [result.object.name, result.isValid]).sort()).toEqual([
				['Bad', false],
				['Good', true],
			]);
			expect(await fileState.getAll('80_completed')).toEqual(['1']);
		});
	});

	test('deleteObjectFolder removes the folder and everything in it', async () => {
		await seedDownload(makeObject(), OBJECT_FOLDER);

		await validation.deleteObjectFolder(OBJECT_FOLDER);

		expect(await env.adapter.exists(OBJECT_FOLDER)).toBe(false);
		expect([...env.adapter.files.keys()].filter(path => path.startsWith(OBJECT_FOLDER))).toEqual([]);
	});

	describe('validate', () => {
		// Objects are validated concurrently and each adds itself to `all`.
		test('records every validated object in the `all` ledger', async () => {
			await seedGoodAndBad();

			await validation.validate();

			expect((await fileState.getAll('all')).sort()).toEqual(['1', '2']);
		});
	});
});
