import type { ValidationWorkerInput, ValidationWorkerOutput } from './validationWorkerTypes';
import { processValidationPayload } from './validationWorkerProcessor';

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (event: MessageEvent<ValidationWorkerInput>) => {
	const payload = event.data;
	console.log(`Processing on web worker: ${payload.object.id} (${payload.object.name})`);
	const errors = processValidationPayload(payload);
	const response: ValidationWorkerOutput = { errors };
	ctx.postMessage(response);
});

export {};
