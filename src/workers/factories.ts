// esbuild-plugin-inline-worker replaces each `*.worker.ts` module with a function that
// starts it as a Worker. TypeScript only sees the worker source, which has no such export.

// @ts-expect-error see above
import zipWorkerFactory from './zip.worker';
// @ts-expect-error see above
import validationWorkerFactory from './validation.worker';

export const createZipWorker: () => Worker = zipWorkerFactory;
export const createValidationWorker: () => Worker = validationWorkerFactory;
