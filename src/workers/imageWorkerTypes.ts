export interface ImageDownloadJob {
	url: string;
	filename: string;
}

export interface ImageWorkerRequest {
	jobs: ImageDownloadJob[];
	headers?: Record<string, string>;
}

export interface ImageWorkerFileResult {
	filename: string;
	data: ArrayBuffer;
	contentType?: string | null;
}

export interface ImageWorkerResponse {
	files: ImageWorkerFileResult[];
	errors: string[];
}
