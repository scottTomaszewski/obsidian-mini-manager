import { MMFApiService } from '../../../src/services/MMFApiService';
import { OAuth2Service } from '../../../src/services/OAuth2Service';
import { LoggerService } from '../../../src/services/LoggerService';
import { AuthenticationError, HttpError } from '../../../src/models/Errors';
import { API_BASE, FakeMmf } from '../../fakes/fakeMmf';
import { makeObject } from '../../fixtures/mmfObjects';
import { LOG_FILE, PLUGIN_DIR, TestEnv, createEnv, oauthToken, readText, sleep } from '../../fakes/harness';

const SERVER_ERROR = { status: 500, text: 'Internal Server Error' };

describe('MMFApiService', () => {
	let env: TestEnv;
	let mmf: FakeMmf;

	beforeEach(async () => {
		env = await createEnv({ mmfApiKey: 'secret-api-key' });
		mmf = new FakeMmf().install();
	});

	const api = () => {
		const logger = new LoggerService(env.app, PLUGIN_DIR);
		return new MMFApiService(env.settings, logger, new OAuth2Service(env.settings, logger, async () => {}));
	};

	describe('authentication', () => {
		test('sends the API key as a query parameter when there is no OAuth token', async () => {
			mmf.object(makeObject({ id: 1 }));

			await api().getObjectById('1');

			expect(mmf.requests[0].url).toBe(`${API_BASE}/objects/1?key=secret-api-key`);
			expect(mmf.requests[0].headers).not.toHaveProperty('Authorization');
		});

		test('sends a bearer token, and no API key, when an OAuth token is stored', async () => {
			env.settings.oauthToken = oauthToken({ accessToken: 'abc' });
			mmf.object(makeObject({ id: 1 }));

			await api().getObjectById('1');

			expect(mmf.requests[0].url).toBe(`${API_BASE}/objects/1`);
			expect(mmf.requests[0].headers).toMatchObject({ Authorization: 'Bearer abc' });
		});
	});

	describe('getObjectById', () => {
		test('returns the object', async () => {
			mmf.object(makeObject({ id: 1 }));

			await expect(api().getObjectById('1')).resolves.toMatchObject({ id: 1, name: 'Goblin Warband' });
		});

		test('rejects with an AuthenticationError on a 401', async () => {
			mmf.objectResponse('1', { status: 401, json: { error: 'invalid_token', error_description: 'The access token expired' } });

			const error = await api().getObjectById('1').catch(e => e);

			expect(error).toBeInstanceOf(AuthenticationError);
			expect(error.message).toContain('invalid_token: The access token expired');
			expect(mmf.requests).toHaveLength(1);
		});

		// A 403 is about this object (private, not purchased), not about the login.
		test('rejects with an HttpError, not an AuthenticationError, on a 403', async () => {
			mmf.objectResponse('1', { status: 403, json: { error: 'access_denied' } });

			const error = await api().getObjectById('1').catch(e => e);

			expect(error).toBeInstanceOf(HttpError);
			expect(error).not.toBeInstanceOf(AuthenticationError);
			expect(error.status).toBe(403);
			expect(error.message).toContain('Access forbidden');
		});

		test('rejects with an HttpError carrying the status when the object cannot be fetched', async () => {
			const error = await api().getObjectById('1').catch(e => e);

			expect(error).toBeInstanceOf(HttpError);
			expect(error.status).toBe(404);
			expect(error.message).toContain('Resource not found: /objects/1');
			expect(mmf.requests).toHaveLength(1);
		});

		// The reported bug: the plugin believes it is authenticated, the token has in fact
		// expired, and the failure used to be swallowed into a placeholder object.
		test('rejects with an AuthenticationError, without asking the server, when the OAuth token has expired', async () => {
			env.settings.oauthToken = oauthToken({ expired: true });
			mmf.object(makeObject({ id: 1 }));

			await expect(api().getObjectById('1')).rejects.toBeInstanceOf(AuthenticationError);
			expect(mmf.requests).toHaveLength(0);
		});

		test('a 401 for an OAuth token discards the token', async () => {
			env.settings.oauthToken = oauthToken();
			mmf.objectResponse('1', { status: 401, json: { error: 'invalid_token' } });

			await api().getObjectById('1').catch(() => {});

			expect(env.settings.oauthToken).toBe('');
		});

		test('a 403 leaves the OAuth token alone', async () => {
			env.settings.oauthToken = oauthToken();
			mmf.objectResponse('1', { status: 403, json: { error: 'access_denied' } });

			await api().getObjectById('1').catch(() => {});

			expect(env.settings.oauthToken).not.toBe('');
		});
	});

	describe('retries', () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});

		test.each([500, 502, 503, 504, 429])('retries a %i with backoff until it succeeds', async status => {
			mmf.objectResponse('1', [{ status, text: 'try later' }, { status, text: 'try later' }, { json: makeObject({ id: 1 }) }]);

			const result = api().getObjectById('1');
			await jest.advanceTimersByTimeAsync(999);
			expect(mmf.requests).toHaveLength(1);
			await jest.advanceTimersByTimeAsync(1);
			expect(mmf.requests).toHaveLength(2);
			await jest.advanceTimersByTimeAsync(2000);

			await expect(result).resolves.toMatchObject({ id: 1 });
			expect(mmf.requests).toHaveLength(3);
		});

		test('gives up after the configured number of retries', async () => {
			mmf.objectResponse('1', SERVER_ERROR);

			const result = api().getObjectById('1').catch(e => e);
			await jest.advanceTimersByTimeAsync(3000);

			expect((await result).message).toContain('Server error (500)');
			expect(mmf.requests).toHaveLength(3);
		});

		test('does not retry at all when Max Retries is 0', async () => {
			env.settings.maxRetries = 0;
			mmf.objectResponse('1', SERVER_ERROR);

			await expect(api().getObjectById('1')).rejects.toBeInstanceOf(HttpError);
			expect(mmf.requests).toHaveLength(1);
		});

		test('retries a dropped connection', async () => {
			mmf.objectResponse('1', [new Error('net::ERR_FAILED: Failed to fetch'), { json: makeObject({ id: 1 }) }]);

			const result = api().getObjectById('1');
			await jest.advanceTimersByTimeAsync(1000);

			await expect(result).resolves.toMatchObject({ id: 1 });
		});
	});

	describe('searchObjects', () => {
		test('queries /objects and returns the matches', async () => {
			mmf.url(`${API_BASE}/objects`, { json: { objects: [makeObject({ id: 1 })], total_count: 1 } });

			const results = await api().searchObjects('goblin king', 2, 5);

			expect(results).toHaveLength(1);
			expect(mmf.requests[0].url).toBe(`${API_BASE}/objects?q=goblin%20king&page=2&per_page=5&key=secret-api-key`);
		});

		test('returns an empty list when the response has no objects', async () => {
			mmf.url(`${API_BASE}/objects`, { json: {} });

			await expect(api().searchObjects('goblin')).resolves.toEqual([]);
		});

		test('rejects when the search fails', async () => {
			mmf.url(`${API_BASE}/objects`, { status: 401, json: {} });

			await expect(api().searchObjects('goblin')).rejects.toThrow('Failed to search objects: Authentication failed');
		});
	});

	describe('validateApiKey', () => {
		test('is false, without asking the server, when there are no credentials', async () => {
			env.settings.mmfApiKey = '';

			await expect(api().validateApiKey()).resolves.toBe(false);
			expect(mmf.requests).toHaveLength(0);
		});

		test('is true when the server accepts the credentials', async () => {
			mmf.url(`${API_BASE}/objects`, { json: { objects: [] } });

			await expect(api().validateApiKey()).resolves.toBe(true);
		});

		test('is false when the server rejects the credentials', async () => {
			mmf.url(`${API_BASE}/objects`, { status: 401, json: {} });

			await expect(api().validateApiKey()).resolves.toBe(false);
		});
	});

	test('credentials are kept out of the debug log', async () => {
		mmf.object(makeObject({ id: 1 }));
		await api().getObjectById('1');

		env.settings.oauthToken = oauthToken({ accessToken: 'secret-access-token' });
		await api().getObjectById('1');
		await sleep(5);

		const log = readText(env, LOG_FILE);
		expect(log).toContain('/objects/1');
		expect(log).not.toContain('secret-api-key');
		expect(log).not.toContain('secret-access-token');
	});
});
