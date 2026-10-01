import { MiniManagerSettings } from "../settings/MiniManagerSettings";
import { OAuth2Token, isTokenExpired } from "../models/OAuth2Model";
import { AuthenticationError } from "../models/Errors";
import { LoggerService } from "./LoggerService";

export class OAuth2Service {
	private settings: MiniManagerSettings;
	private token: OAuth2Token | null = null;
	private logger: LoggerService;
	private persistSettings: () => Promise<void>;

	/** Called after the user has successfully logged in. */
	public onAuthenticated?: () => void;

	constructor(settings: MiniManagerSettings, logger: LoggerService, persistSettings: () => Promise<void>) {
		this.settings = settings;
		this.logger = logger;
		this.persistSettings = persistSettings;

		if (settings.oauthToken) {
			try {
				this.token = JSON.parse(settings.oauthToken);
				this.logger.info("Loaded OAuth token from settings");
			} catch (error: any) {
				this.logger.error(`Failed to parse OAuth token: ${error.message}`);
				this.token = null;
			}
		}
	}

	/** Whether a token is stored at all, valid or not. */
	hasToken(): boolean {
		return this.token !== null;
	}

	/** Whether there is a token that has not expired. The server may still reject it. */
	isAuthenticated(): boolean {
		return this.token !== null && !isTokenExpired(this.token);
	}

	/**
	 * Returns a valid access token or throws an AuthenticationError if none is available.
	 * Caller should catch and trigger "reconnect to MyMiniFactory" UI.
	 */
	async getAccessToken(): Promise<string> {
		if (this.token && !isTokenExpired(this.token)) {
			return this.token.access_token;
		}

		this.logger.warn("No valid MMF access token. User needs to re-authenticate.");
		throw new AuthenticationError("MyMiniFactory access token missing or expired. Please reconnect in the plugin settings.");
	}

	/**
	 * For MMF implicit flow:
	 * 1. You open the authorize URL with response_type=token and a state value.
	 * 2. MMF redirects to redirectUri with a fragment:
	 *    #access_token=...&expires_in=...&token_type=Bearer&state=...
	 * 3. User copies the full URL from the browser address bar.
	 * 4. You call this method with that URL (and the expected state, if you use one).
	 */
	public async exchangeCodeForToken(redirectUrl: string, expectedState?: string): Promise<void> {
		try {
			const url = new URL(redirectUrl);
			const fragment = url.hash.startsWith("#")
				? url.hash.substring(1)
				: url.hash;

			if (!fragment) {
				throw new Error("Redirect URL does not contain an access_token fragment.");
			}

			const params = new URLSearchParams(fragment);

			const state = params.get("state");
			if (expectedState && state !== expectedState) {
				throw new Error("State mismatch. Make sure you pasted the most recent redirect URL.");
			}

			const accessToken = params.get("access_token");
			if (!accessToken) {
				throw new Error("No access_token found in redirect URL fragment.");
			}

			const expiresInStr = params.get("expires_in") ?? "0";
			const expiresIn = parseInt(expiresInStr, 10) || 0;

			const tokenType = params.get("token_type") || "Bearer";

			// MMF implicit flow does not return a refresh_token; when the token expires the
			// user has to log in again.
			this.token = {
				access_token: accessToken,
				token_type: tokenType,
				expires_in: expiresIn,
				created_at: Math.floor(Date.now() / 1000),
			};
			this.settings.oauthToken = JSON.stringify(this.token);
			await this.persistSettings();

			this.logger.info("Successfully stored MyMiniFactory access token from redirect URL");
		} catch (error: any) {
			this.logger.error(`Error parsing MMF redirect URL: ${error.message}`);
			throw new Error(`Failed to extract access token from redirect URL: ${error.message}`);
		}

		this.onAuthenticated?.();
	}

	/**
	 * Forgets a token the server rejected. Does nothing if that is no longer the stored
	 * token: a request sent before the user logged in again can be rejected after.
	 */
	async invalidateToken(rejectedAccessToken: string): Promise<void> {
		if (this.token?.access_token !== rejectedAccessToken) return;
		this.token = null;
		this.settings.oauthToken = "";
		await this.persistSettings();
	}
}
