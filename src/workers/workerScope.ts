/** The parts of a dedicated worker's global scope that the workers use. */
export interface WorkerScope {
	addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
	postMessage(message: unknown, transfer?: Transferable[]): void;
}
