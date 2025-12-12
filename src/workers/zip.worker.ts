import JSZip from 'jszip';

interface ZipWorkerRequest {
	zipData: ArrayBuffer;
}

interface ZipEntry {
	filename: string;
	content: ArrayBuffer;
}

interface ZipWorkerResponse {
	entries: ZipEntry[];
	error?: string;
}

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', async (event: MessageEvent<ZipWorkerRequest>) => {
	const { zipData } = event.data;
	try {
		const zip = await JSZip.loadAsync(zipData);
		const entries: ZipEntry[] = [];

		const files = Object.keys(zip.files);
		for (const filename of files) {
			const file = zip.files[filename];
			if (file.dir) continue;
			const content = await file.async('arraybuffer');
			entries.push({ filename, content });
		}

		const response: ZipWorkerResponse = { entries };
		ctx.postMessage(response, entries.map(e => e.content));
	} catch (error) {
		const response: ZipWorkerResponse = { entries: [], error: error instanceof Error ? error.message : String(error) };
		ctx.postMessage(response);
	}
});

export {};
