import { MMFObject } from '../models/MMFObject';

export interface DownloadJob {
    id: string;
    object: MMFObject;
    status: 'pending' | 'downloading' | 'extracting' | 'completed' | 'failed';
    progress: number; // 0-100
    progressMessage: string;
    error?: string;
}

export class DownloadManager {
    private static instance: DownloadManager;
    private jobs: Map<string, DownloadJob> = new Map();
    private listeners: ((jobs: DownloadJob[]) => void)[] = [];

    private constructor() {}

    public static getInstance(): DownloadManager {
        if (!DownloadManager.instance) {
            DownloadManager.instance = new DownloadManager();
        }
        return DownloadManager.instance;
    }

    public addJob(object: MMFObject): DownloadJob {
        const job: DownloadJob = {
            id: object.id.toString(),
            object,
            status: 'pending',
            progress: 0,
            progressMessage: 'Queued',
        };
        this.jobs.set(job.id, job);
        this.notifyListeners();
        return job;
    }

    public updateJob(id: string, status: DownloadJob['status'], progress: number, progressMessage: string, error?: string) {
        const job = this.jobs.get(id);
        if (job) {
            job.status = status;
            job.progress = progress;
            job.progressMessage = progressMessage;
            if (error) {
                job.error = error;
            }
            this.notifyListeners();
        }
    }

    public getJobs(): DownloadJob[] {
        return Array.from(this.jobs.values());
    }

    public clearCompleted() {
        this.jobs.forEach((job, id) => {
            if (job.status === 'completed') {
                this.jobs.delete(id);
            }
        });
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
}
