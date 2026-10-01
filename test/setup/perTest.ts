import { requestUrl } from 'obsidian';
import { Notice } from '../mocks/obsidian';

beforeEach(() => {
	Notice.reset();

	// No test talks to the real MyMiniFactory: anything not routed through FakeMmf fails loudly.
	(requestUrl as unknown as jest.Mock).mockReset();
	(requestUrl as unknown as jest.Mock).mockImplementation(async (params: { url?: string }) => {
		throw new Error(`Unexpected network request in a test: ${params?.url ?? params}`);
	});

	// The services log failures to the console as a matter of course.
	jest.spyOn(console, 'error').mockImplementation(() => {});
	jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
	jest.restoreAllMocks();
	jest.useRealTimers();
});
