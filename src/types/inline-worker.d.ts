declare module '*.worker.ts' {
	const createWorker: () => Worker;
	export default createWorker;
}

declare module '*.worker.js' {
	const createWorker: () => Worker;
	export default createWorker;
}
