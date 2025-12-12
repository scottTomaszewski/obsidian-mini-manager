import type { ValidationWorkerInput } from './validationWorkerTypes';

export function processValidationPayload(payload: ValidationWorkerInput): string[] {
	const errors: string[] = [];

	// README validation
	if (!payload.readme.exists) {
		errors.push('README.md is missing.');
	} else {
		const content = payload.readme.content ?? '';
		if (!content.startsWith('---') || !content.includes('---')) {
			errors.push('README.md is missing frontmatter.');
		}
	}

	// Images validation
	if (payload.images.enabled) {
		if (payload.images.folderMissing) {
			errors.push('Images folder is missing.');
		} else if (payload.images.found < payload.images.expected) {
			errors.push(`Missing images. Expected ${payload.images.expected}, found ${payload.images.found}.`);
		}
	}

	// Files validation
	if (payload.files.enabled) {
		if (payload.files.folderMissing) {
			errors.push('Files folder is missing.');
		} else {
			for (const item of payload.files.items) {
				if (!item.exists) {
					errors.push(`Missing file: ${item.filename}`);
				} else if (item.isHtml) {
					errors.push(`File ${item.filename} is HTML content, not a valid file (possible login redirect).`);
				}
			}
		}
	}

	return errors;
}
