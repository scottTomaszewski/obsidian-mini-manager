import { MMFObject } from '../models/MMFObject';
import { FileStateService } from './FileStateService';

export interface DownloadJob {
	id: string;
	object: MMFObject;
	status: 'pending' | 'downloading' | 'extracting' | 'completed' | 'failed' | 'validating' | 'cancelled' | 'queued' | 'preparing' | 'downloading_images';
	progress: number; // 0-100
	progressMessage: string;
	error?: string;
}

export class DownloadManager {
	private static instance: DownloadManager;
	private fileStateService: FileStateService;
	private jobs: Map<string, DownloadJob> = new Map();
	private listeners: ((jobs: DownloadJob[]) => void)[] = [];

	private constructor(fileStateService: FileStateService) {
		this.fileStateService = fileStateService;
		this.loadAllJobs();
	}

	public static getInstance(fileStateService?: FileStateService): DownloadManager {
		if (!DownloadManager.instance) {
			if (!fileStateService) {
				throw new Error("FileStateService must be provided on first instantiation of DownloadManager.");
			}
			DownloadManager.instance = new DownloadManager(fileStateService);
		}
		return DownloadManager.instance;
	}

	private async loadAllJobs() {
		const ids = await this.fileStateService.getAllJobIds();
		for (const id of ids) {
			const job = await this.fileStateService.getJob(id);
			if (job) {
				this.jobs.set(id, job);
			}
		}
		this.notifyListeners();
	}

	public async addJob(object: MMFObject): Promise<DownloadJob> {
		const job: DownloadJob = {
			id: object.id.toString(),
			object,
			status: 'pending',
			progress: 0,
			progressMessage: 'Queued',
		};
		this.jobs.set(job.id, job);
		await this.fileStateService.saveJob(job);
		this.notifyListeners();
		return job;
	}

	public async updateJob(id: string, status: DownloadJob['status'], progress: number, progressMessage: string, error?: string) {
		let job = this.jobs.get(id);
		if (!job) {
			job = await this.fileStateService.getJob(id);
		}

		if (job) {
			job.status = status;
			job.progress = progress;
			job.progressMessage = progressMessage;
			if (error) {
				job.error = error;
			} else {
				delete job.error;
			}
			this.jobs.set(id, job);
			await this.fileStateService.saveJob(job);
			this.notifyListeners();
		}
	}

	public async updateJobObject(id: string, object: MMFObject) {
		const job = this.jobs.get(id) || await this.fileStateService.getJob(id);
		if (job) {
			job.object = object;
			this.jobs.set(id, job);
			await this.fileStateService.saveJob(job);
			this.notifyListeners();
		}
	}

	public getJob(id: string): DownloadJob | undefined {
		return this.jobs.get(id);
	}

	public getJobs(): DownloadJob[] {
		return Array.from(this.jobs.values()).sort((a, b) => (a.object.name || '').localeCompare(b.object.name || ''));
	}

	public async removeJob(id: string) {
		// Just in case, make sure we dont lose it
		await this.fileStateService.add('all', id);

		if (this.jobs.has(id)) {
			this.jobs.delete(id);
		}
		await this.fileStateService.removeJob(id);
		// also remove from any state files
		await this.fileStateService.remove('queued', id);
		await this.fileStateService.remove('downloading', id);
		await this.fileStateService.remove('completed', id);
		await this.fileStateService.remove('failed', id);
		await this.fileStateService.remove('cancelled', id);
		await this.fileStateService.remove('validating', id);

		this.notifyListeners();
	}

	public async clearCompleted() {
		for (const job of this.jobs.values()) {
			if (job.status === 'completed') {
				await this.removeJob(job.id);
			}
		}
	}

	public getCompletedJobsCount(): number {
		return this.getJobs().filter(job => job.status === 'completed').length;
	}

	public getFailedJobsCount(): number {
		return this.getJobs().filter(job => job.status === 'failed').length;
	}

	public async clearFailed() {
		for (const job of this.jobs.values()) {
			if (job.status === 'failed') {
				await this.removeJob(job.id);
			}
		}
	}

	public subscribe(listener: (jobs: DownloadJob[]) => void) {
		this.listeners.push(listener);
	}

	public unsubscribe(listener: (jobs: DownloadJob[]) => void) {
		this.listeners = this.listeners.filter(l => l !== listener);
	}

	private notifyListeners() {
		const jobs = this.getJobs();
		this.listeners.forEach(listener => listener(jobs));
	}
}
