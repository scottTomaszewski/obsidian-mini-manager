import type { ImageWorkerRequest, ImageWorkerResponse } from './imageWorkerTypes';

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', async (event: MessageEvent<ImageWorkerRequest>) => {
	const { jobs, headers } = event.data;
	const files: ImageWorkerResponse['files'] = [];
	const errors: string[] = [];

	for (const job of jobs) {
		try {
			const response = await fetch(job.url, { headers: headers ?? {}, cache: 'no-store' });
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const contentType = response.headers.get('content-type');
			if (contentType && contentType.includes('text/html')) {
				throw new Error('Invalid content type: received text/html (possible redirect/login).');
			}
			const data = await response.arrayBuffer();
			files.push({
				filename: job.filename,
				data,
				contentType,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`Failed ${job.filename}: ${message}`);
		}
	}

	ctx.postMessage(
		{ files, errors } satisfies ImageWorkerResponse,
		files.map(f => f.data)
	);
});

export {};
