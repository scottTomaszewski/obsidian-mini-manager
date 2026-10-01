// Stands in for an inline `*.worker.ts` import. Node has no Worker, so callers are expected
// to take their main-thread fallback.
export default function createWorker(): Worker {
	throw new Error('Workers are not available in tests.');
}
