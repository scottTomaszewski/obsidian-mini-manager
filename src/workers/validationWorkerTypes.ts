import type { MMFObject } from '../models/MMFObject';

export interface ValidationWorkerFileCheck {
	filename: string;
	exists: boolean;
	isHtml: boolean;
}

export interface ValidationWorkerInput {
	object: MMFObject;
	folderPath: string;
	readme: {
		exists: boolean;
		content?: string;
	};
	images: {
		enabled: boolean;
		expected: number;
		found: number;
		folderMissing: boolean;
	};
	files: {
		enabled: boolean;
		folderMissing: boolean;
		items: ValidationWorkerFileCheck[];
	};
}

export interface ValidationWorkerOutput {
	errors: string[];
}
