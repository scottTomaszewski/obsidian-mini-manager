import type { MMFObject } from '../../src/models/MMFObject';

export const OBJECT_ID = '12345';
export const IMAGE_1_URL = 'https://cdn.myminifactory.com/assets/object-assets/goblin/images/720X720-front.jpg';
export const IMAGE_2_URL = 'https://cdn.myminifactory.com/assets/object-assets/goblin/images/720X720-back.png';
export const STL_URL = 'https://www.myminifactory.com/download/900001';
export const ZIP_URL = 'https://www.myminifactory.com/download/900002';

/** Where the default download path puts makeObject(). */
export const OBJECT_FOLDER = 'MyMiniFactory/Test Designer/Goblin Warband';

/** Shaped like a GET /objects/{id} response: two images and one STL. */
export function makeObject(overrides: Partial<MMFObject> = {}): MMFObject {
	return {
		id: Number(OBJECT_ID),
		name: 'Goblin Warband',
		url: 'https://www.myminifactory.com/object/3d-print-goblin-warband-12345',
		description: 'A warband of goblins.',
		tags: ['goblin', 'fantasy'],
		designer: {
			id: 77,
			name: 'Test Designer',
			url: 'https://www.myminifactory.com/users/TestDesigner',
		},
		images: [
			{ id: 1, is_primary: true, original: { url: IMAGE_1_URL } },
			{ id: 2, original: { url: IMAGE_2_URL } },
		],
		files: {
			total_count: 1,
			items: [{ id: 900001, filename: 'goblin.stl', size: 2048, download_url: STL_URL }],
		},
		...overrides,
	};
}

export function bytes(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer;
}
