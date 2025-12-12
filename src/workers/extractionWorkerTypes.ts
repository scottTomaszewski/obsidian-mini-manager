// Types shared by main thread and worker
export type ExtractZipRequest = {
	type: "extractZip";
	jobId: string;
	zipData: ArrayBuffer;      // transferred
	destinationPath: string;   // vault-relative base path
	skipExisting?: boolean;
	batchSize?: number;        // default 10-50
};

export type ExtractZipAbort = {
	type: "abort";
	jobId: string;
};

export type ExtractZipResponse =
	| { type: "start"; jobId: string; totalEntries: number }
	| { type: "batch"; jobId: string; entries: Array<{ relPath: string; data: ArrayBuffer }> }
	| { type: "done"; jobId: string }
	| { type: "error"; jobId: string; error: string };
