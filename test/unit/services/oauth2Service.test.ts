import { OAuth2Service } from '../../../src/services/OAuth2Service';
import { isTokenExpired, OAuth2Token } from '../../../src/models/OAuth2Model';
import { AuthenticationError } from '../../../src/models/Errors';
import { LoggerService } from '../../../src/services/LoggerService';
import { PLUGIN_DIR, TestEnv, createEnv, oauthToken } from '../../fakes/harness';

const REDIRECT = 'https://www.myminifactory.com/oauth/callback';

describe('OAuth2Service', () => {
	let env: TestEnv;
	let logger: LoggerService;

	beforeEach(async () => {
		env = await createEnv();
		logger = new LoggerService(env.app, PLUGIN_DIR);
	});

	let persist: jest.Mock;

	beforeEach(() => {
		persist = jest.fn(async () => {});
	});

	const service = () => new OAuth2Service(env.settings, logger, persist);

	describe('getAccessToken', () => {
		test('returns the stored token while it is still valid', async () => {
			env.settings.oauthToken = oauthToken({ accessToken: 'abc' });

			await expect(service().getAccessToken()).resolves.toBe('abc');
		});

		test('rejects with an AuthenticationError when there is no token', async () => {
			const error = await service().getAccessToken().catch(e => e);

			expect(error).toBeInstanceOf(AuthenticationError);
			expect(error.message).toContain('missing or expired');
		});

		// A plain Error here is what used to let an expired token be mistaken for an ordinary
		// API failure further up the stack.
		test('rejects with an AuthenticationError when the token has expired', async () => {
			env.settings.oauthToken = oauthToken({ expired: true });

			await expect(service().getAccessToken()).rejects.toBeInstanceOf(AuthenticationError);
		});

		test('treats an unparseable stored token as no token', async () => {
			env.settings.oauthToken = '{ not json';

			await expect(service().getAccessToken()).rejects.toThrow('missing or expired');
		});
	});

	describe('hasToken and isAuthenticated', () => {
		test('no token: neither', () => {
			expect(service().hasToken()).toBe(false);
			expect(service().isAuthenticated()).toBe(false);
		});

		test('valid token: both', () => {
			env.settings.oauthToken = oauthToken();

			expect(service().hasToken()).toBe(true);
			expect(service().isAuthenticated()).toBe(true);
		});

		test('expired token: has one, but is not authenticated', () => {
			env.settings.oauthToken = oauthToken({ expired: true });

			expect(service().hasToken()).toBe(true);
			expect(service().isAuthenticated()).toBe(false);
		});
	});

	describe('exchangeCodeForToken', () => {
		test('reads the token out of the redirect URL fragment and stores it in settings', async () => {
			const oauth2 = service();

			await oauth2.exchangeCodeForToken(`${REDIRECT}#access_token=abc&expires_in=3600&token_type=Bearer&state=xyz`, 'xyz');

			await expect(oauth2.getAccessToken()).resolves.toBe('abc');
			expect(JSON.parse(env.settings.oauthToken)).toMatchObject({
				access_token: 'abc',
				expires_in: 3600,
				token_type: 'Bearer',
			});
			expect(persist).toHaveBeenCalledTimes(1);
		});

		test('announces a successful login', async () => {
			const oauth2 = service();
			oauth2.onAuthenticated = jest.fn();

			await oauth2.exchangeCodeForToken(`${REDIRECT}#access_token=abc&expires_in=3600`);

			expect(oauth2.onAuthenticated).toHaveBeenCalledTimes(1);
		});

		test('does not announce a failed login', async () => {
			const oauth2 = service();
			oauth2.onAuthenticated = jest.fn();

			await oauth2.exchangeCodeForToken(`${REDIRECT}#error=access_denied`).catch(() => {});

			expect(oauth2.onAuthenticated).not.toHaveBeenCalled();
		});

		test('rejects a redirect whose state does not match', async () => {
			await expect(
				service().exchangeCodeForToken(`${REDIRECT}#access_token=abc&expires_in=3600&state=other`, 'xyz')
			).rejects.toThrow('State mismatch');
			expect(env.settings.oauthToken).toBe('');
		});

		test('rejects a URL with no fragment', async () => {
			await expect(service().exchangeCodeForToken(REDIRECT)).rejects.toThrow('does not contain an access_token');
		});

		test('rejects a fragment with no access_token', async () => {
			await expect(service().exchangeCodeForToken(`${REDIRECT}#error=access_denied`)).rejects.toThrow('No access_token');
		});

		test('rejects text that is not a URL', async () => {
			await expect(service().exchangeCodeForToken('not a url')).rejects.toThrow('Failed to extract access token');
		});
	});

	describe('invalidateToken', () => {
		test('forgets the rejected token and saves the settings', async () => {
			env.settings.oauthToken = oauthToken({ accessToken: 'abc' });
			const oauth2 = service();

			await oauth2.invalidateToken('abc');

			expect(env.settings.oauthToken).toBe('');
			expect(oauth2.hasToken()).toBe(false);
			expect(persist).toHaveBeenCalledTimes(1);
			await expect(oauth2.getAccessToken()).rejects.toThrow();
		});

		// A request sent before the user logged in again can be rejected after they have.
		test('leaves the stored token alone when a different token was rejected', async () => {
			env.settings.oauthToken = oauthToken({ accessToken: 'fresh' });
			const oauth2 = service();

			await oauth2.invalidateToken('stale');

			expect(oauth2.isAuthenticated()).toBe(true);
			expect(persist).not.toHaveBeenCalled();
		});
	});

	describe('isTokenExpired', () => {
		const token = (createdSecondsAgo: number, expiresIn: number): OAuth2Token => ({
			access_token: 'abc',
			token_type: 'Bearer',
			expires_in: expiresIn,
			created_at: Math.floor(Date.now() / 1000) - createdSecondsAgo,
		});

		test('is false before the lifetime has elapsed', () => {
			expect(isTokenExpired(token(10, 3600))).toBe(false);
		});

		test('is true once the lifetime has elapsed', () => {
			expect(isTokenExpired(token(3600, 3600))).toBe(true);
		});
	});
});
