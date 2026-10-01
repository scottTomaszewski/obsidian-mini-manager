import { MMFObject } from '../models/MMFObject';
import { FileStateService } from './FileStateService';

export interface DownloadJob {
	id: string;
	object: MMFObject;
	status: 'pending' | '70_downloading' | 'extracting' | '80_completed' | 'failed' | '10_validating' | 'cancelled' | '00_queued' | '30_preparing' | '50_downloading_images' | '20_validated' | '40_prepared' | '60_images_downloaded';
	progress: number; // 0-100
	progressMessage: string;
	error?: string;
}

export class DownloadManager {
	private fileStateService: FileStateService;
	private jobs: Map<string, DownloadJob> = new Map();
	private listeners: ((jobs: DownloadJob[]) => void)[] = [];
	private readonly yieldDelayMs = 0;

	constructor(fileStateService: FileStateService) {
		this.fileStateService = fileStateService;
	}

	/** Loads the jobs persisted by earlier sessions. */
	public async init(): Promise<void> {
		const ids = await this.fileStateService.getAllJobFileIds();
		// Read in batches: a large library has a job file per object and this runs on startup.
		const batchSize = 50;
		for (let i = 0; i < ids.length; i += batchSize) {
			const jobs = await Promise.all(ids.slice(i, i + batchSize).map(id => this.fileStateService.getJob(id)));
			for (const job of jobs) {
				if (job) {
					this.jobs.set(job.id, job);
				}
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
		const job = this.jobs.get(id) ?? await this.fileStateService.getJob(id);

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

	/** Drops the job record. The object stays in whatever state it is in. */
	public async forgetJob(id: string) {
		this.jobs.delete(id);
		await this.fileStateService.removeJob(id);
		this.notifyListeners();
	}

	/** Drops the job record and takes the object out of the pipeline. */
	public async removeJob(id: string) {
		// Just in case, make sure we dont lose it
		await this.fileStateService.add('all', id);
		await this.fileStateService.clearState([id]);
		await this.forgetJob(id);
	}

	public async clearCompleted() {
		const completedIds: string[] = [];
		for (const job of this.jobs.values()) {
			if (job.status === '80_completed') {
				completedIds.push(job.id);
			}
		}
		if (completedIds.length === 0) return;

		await this.fileStateService.bulkRemove(['80_completed'], completedIds);
		await this.fileStateService.bulkRemoveJobs(completedIds);

		const batchSize = 200;
		for (let i = 0; i < completedIds.length; i += batchSize) {
			const batch = completedIds.slice(i, i + batchSize);
			for (const id of batch) {
				this.jobs.delete(id);
			}
			await this.yieldToEventLoop();
		}
		this.notifyListeners();
	}

	public getCompletedJobsCount(): number {
		return this.getJobs().filter(job => job.status === '80_completed').length;
	}

	/** Failed objects, whether or not a job record survives for them. */
	private getFailedIds(): string[] {
		const failedIds = new Set(this.fileStateService.getFailedIds());
		for (const job of this.jobs.values()) {
			if (job.status === 'failed') {
				failedIds.add(job.id);
			}
		}
		return Array.from(failedIds);
	}

	public getFailedJobsCount(): number {
		return this.getFailedIds().length;
	}

	public async clearFailed() {
		const failedIds = this.getFailedIds();
		if (failedIds.length === 0) return;

		await this.fileStateService.clearState(failedIds);
		await this.fileStateService.bulkRemoveJobs(failedIds);

		for (const id of failedIds) {
			this.jobs.delete(id);
		}
		this.notifyListeners();
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

	private async yieldToEventLoop(): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, this.yieldDelayMs));
	}
}
