import { MiniManagerSettings } from "../settings/MiniManagerSettings";
import { OAuth2Token, isTokenExpired } from "../models/OAuth2Model";
import { LoggerService } from "./LoggerService";

export class OAuth2Service {
	private settings: MiniManagerSettings;
	private token: OAuth2Token | null = null;
	private logger: LoggerService;

	constructor(settings: MiniManagerSettings, logger: LoggerService) {
		this.settings = settings;
		this.logger = logger;

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

	/**
	 * Returns a valid access token or throws if none is available.
	 * Caller should catch and trigger "reconnect to MyMiniFactory" UI.
	 */
	async getAccessToken(): Promise<string> {
		if (this.token && !isTokenExpired(this.token)) {
			return this.token.access_token;
		}

		this.logger.warn("No valid MMF access token. User needs to re-authenticate.");
		throw new Error("MyMiniFactory access token missing or expired. Please reconnect in the plugin settings.");
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

			// Adapt this to your OAuth2Token interface
			const tokenData: OAuth2Token = {
				access_token: accessToken,
				token_type: tokenType,
				expires_in: expiresIn,
				// MMF implicit flow usually does not return a refresh_token
				// so we simply do not set it.
				created_at: Math.floor(Date.now() / 1000),
			};

			this.token = tokenData;
			await this.saveToken();

			this.logger.info("Successfully stored MyMiniFactory access token from redirect URL");
		} catch (error: any) {
			this.logger.error(`Error parsing MMF redirect URL: ${error.message}`);
			throw new Error(`Failed to extract access token from redirect URL: ${error.message}`);
		}
	}

	/**
	 * Left here only so existing callers do not silently do something wrong.
	 * Do not use client_credentials with MMF from a public Obsidian plugin.
	 */
	private async getNewToken(): Promise<void> {
		throw new Error(
			"getNewToken (client_credentials) is not supported for MyMiniFactory. " +
			"Use the implicit flow and exchangeCodeForToken(redirectUrl) instead."
		);
	}

	/**
	 * MMF implicit flow does not provide a refresh_token in typical examples.
	 * When the token expires, you should ask the user to re-auth via the browser.
	 */
	private async refreshToken(): Promise<void> {
		throw new Error(
			"refreshToken is not supported for MyMiniFactory implicit flow. " +
			"Ask the user to reconnect when the token expires."
		);
	}

	private async saveToken(): Promise<void> {
		if (this.token) {
			this.settings.oauthToken = JSON.stringify(this.token);
		}
	}

	clearToken(): void {
		this.token = null;
		this.settings.oauthToken = "";
	}
}
