import type { ValidationWorkerInput, ValidationWorkerOutput } from './validationWorkerTypes';
import { processValidationPayload } from './validationWorkerProcessor';
import type { WorkerScope } from './workerScope';

const ctx = self as unknown as WorkerScope;

ctx.addEventListener('message', (event: MessageEvent<ValidationWorkerInput>) => {
	const payload = event.data;
	// console.log(`Processing on web worker: ${payload.object.id} (${payload.object.name})`);
	const errors = processValidationPayload(payload);
	const response: ValidationWorkerOutput = { errors };
	ctx.postMessage(response);
});

export {};
