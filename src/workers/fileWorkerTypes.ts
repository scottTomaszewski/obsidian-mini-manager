export interface FileWorkerRequest {
	url: string;
	filename: string;
	headers?: Record<string, string>;
}

export interface FileWorkerResponse {
	filename: string;
	success: boolean;
	status?: number;
	contentType?: string | null;
	data?: ArrayBuffer;
	error?: string;
}
