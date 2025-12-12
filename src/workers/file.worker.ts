import type { FileWorkerRequest, FileWorkerResponse } from './fileWorkerTypes';

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', async (event: MessageEvent<FileWorkerRequest>) => {
	const { url, headers, filename } = event.data;

	try {
		const response = await fetch(url, { headers: headers ?? {}, cache: 'no-store' });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		const contentType = response.headers.get('content-type');
		if (contentType && contentType.includes('text/html')) {
			throw new Error('Invalid content type: received text/html (possible redirect/login).');
		}

		const data = await response.arrayBuffer();

		const successResponse: FileWorkerResponse = {
			filename,
			success: true,
			status: response.status,
			contentType,
			data,
		};

		ctx.postMessage(successResponse, [data]);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const failResponse: FileWorkerResponse = {
			filename,
			success: false,
			error: message,
		};
		ctx.postMessage(failResponse);
	}
});

export {};
