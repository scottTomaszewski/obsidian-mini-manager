import { processValidationPayload } from '../../../src/workers/validationWorkerProcessor';
import type { ValidationWorkerInput } from '../../../src/workers/validationWorkerTypes';
import { OBJECT_FOLDER, makeObject } from '../../fixtures/mmfObjects';

function payload(overrides: Partial<ValidationWorkerInput> = {}): ValidationWorkerInput {
	return {
		object: makeObject(),
		folderPath: OBJECT_FOLDER,
		readme: { exists: true, content: '---\nname: Goblin Warband\n---\n\n# Goblin Warband\n' },
		images: { enabled: true, expected: 2, found: 2, folderMissing: false },
		files: { enabled: true, folderMissing: false, items: [{ filename: 'goblin.stl', exists: true, isHtml: false }] },
		...overrides,
	};
}

describe('processValidationPayload', () => {
	test('a complete download has no errors', () => {
		expect(processValidationPayload(payload())).toEqual([]);
	});

	test('reports a missing README', () => {
		expect(processValidationPayload(payload({ readme: { exists: false } }))).toEqual(['README.md is missing.']);
	});

	test('reports a README without frontmatter', () => {
		expect(processValidationPayload(payload({ readme: { exists: true, content: '# Goblin Warband' } }))).toEqual([
			'README.md is missing frontmatter.',
		]);
	});

	test('reports a missing images folder', () => {
		const images = { enabled: true, expected: 2, found: 0, folderMissing: true };

		expect(processValidationPayload(payload({ images }))).toEqual(['Images folder is missing.']);
	});

	test('reports too few images', () => {
		const images = { enabled: true, expected: 2, found: 1, folderMissing: false };

		expect(processValidationPayload(payload({ images }))).toEqual(['Missing images. Expected 2, found 1.']);
	});

	test('reports a missing files folder', () => {
		const files = { enabled: true, folderMissing: true, items: [{ filename: 'goblin.stl', exists: false, isHtml: false }] };

		expect(processValidationPayload(payload({ files }))).toEqual(['Files folder is missing.']);
	});

	test('reports each missing file and each file that is really an HTML page', () => {
		const files = {
			enabled: true,
			folderMissing: false,
			items: [
				{ filename: 'goblin.stl', exists: false, isHtml: false },
				{ filename: 'goblins.zip', exists: true, isHtml: true },
			],
		};

		expect(processValidationPayload(payload({ files }))).toEqual([
			'Missing file: goblin.stl',
			'File goblins.zip is HTML content, not a valid file (possible login redirect).',
		]);
	});

	test('skips image and file checks when they are disabled', () => {
		const result = processValidationPayload(
			payload({
				images: { enabled: false, expected: 2, found: 0, folderMissing: true },
				files: { enabled: false, folderMissing: true, items: [] },
			})
		);

		expect(result).toEqual([]);
	});
});
