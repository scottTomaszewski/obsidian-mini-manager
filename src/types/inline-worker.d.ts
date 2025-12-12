declare module '*.worker.ts' {
	const createWorker: () => Worker;
	export default createWorker;
}
