// Stands in for src/workers/zip.worker.ts: same message protocol, run in-process with JSZip.
import JSZip from 'jszip';

interface ZipEntry {
	filename: string;
	content: ArrayBuffer;
}

class InProcessZipWorker {
	onmessage: ((event: { data: { entries: ZipEntry[]; error?: string } }) => void) | null = null;
	onerror: ((error: unknown) => void) | null = null;
	private terminated = false;

	postMessage(message: { zipData: ArrayBuffer }): void {
		void this.run(message.zipData);
	}

	terminate(): void {
		this.terminated = true;
	}

	private async run(zipData: ArrayBuffer): Promise<void> {
		let data: { entries: ZipEntry[]; error?: string };
		try {
			const zip = await JSZip.loadAsync(zipData);
			const entries: ZipEntry[] = [];
			for (const filename of Object.keys(zip.files)) {
				const file = zip.files[filename];
				if (file.dir) continue;
				entries.push({ filename, content: await file.async('arraybuffer') });
			}
			data = { entries };
		} catch (error) {
			data = { entries: [], error: error instanceof Error ? error.message : String(error) };
		}
		if (!this.terminated) this.onmessage?.({ data });
	}
}

export default function createZipWorker(): Worker {
	return new InProcessZipWorker() as unknown as Worker;
}
