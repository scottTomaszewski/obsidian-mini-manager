import { requestUrl } from "obsidian";
import { MiniManagerSettings } from "../settings/MiniManagerSettings";
import { OAuth2Token, isTokenExpired } from "../models/OAuth2Model";

export class OAuth2Service {
    private settings: MiniManagerSettings;
    private token: OAuth2Token | null = null;
    private tokenEndpoint = "https://api.myminifactory.com/v2/oauth/token";
    
    constructor(settings: MiniManagerSettings) {
        this.settings = settings;
        
        // Load token from settings if available
        if (settings.oauthToken) {
            try {
                this.token = JSON.parse(settings.oauthToken);
                console.log("Loaded OAuth token from settings");
            } catch (error) {
                console.error("Failed to parse OAuth token:", error);
                this.token = null;
            }
        }
    }
    
    /**
     * DEPRECATED: This service is no longer used as the plugin now uses API key authentication
     * Keeping the file for reference and backwards compatibility
     * 
     * Get a valid access token, refreshing if necessary
     */
    async getAccessToken(): Promise<string> {
        // Check if we have a token and if it's still valid
        if (this.token && !isTokenExpired(this.token)) {
            return this.token.access_token;
        }
        
        // If we have a refresh token, try to use it
        if (this.token?.refresh_token) {
            try {
                await this.refreshToken();
                return this.token!.access_token;
            } catch (error) {
                console.error("Failed to refresh token:", error);
                // If refresh fails, fall back to client credentials flow
            }
        }
        
        // Otherwise get a new token using client credentials
        await this.getNewToken();
        return this.token!.access_token;
    }
    
    /**
     * Get a new token using client credentials flow
     */
    private async getNewToken(): Promise<void> {
        if (!this.settings.clientId || !this.settings.clientSecret) {
            throw new Error("Client ID and Client Secret are required");
        }
        
        try {
            // MyMiniFactory requires application/x-www-form-urlencoded format
            const body = new URLSearchParams();
            body.append("grant_type", "client_credentials");
            body.append("client_id", this.settings.clientId);
            body.append("client_secret", this.settings.clientSecret);
            body.append("scope", "objects");
            
            // Convert URLSearchParams to string
            const bodyString = body.toString();
            
            console.log(`Requesting token from: ${this.tokenEndpoint}`);
            
            const response = await requestUrl({
                url: this.tokenEndpoint,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: bodyString
            });
            
            if (response.status !== 200) {
                throw new Error(`Failed to get token: ${response.status} ${response.text}`);
            }
            
            // Parse response and store token
            const tokenData = response.json;
            this.token = {
                ...tokenData,
                created_at: Math.floor(Date.now() / 1000)
            };
            
            // Save token to settings
            await this.saveToken();
            
            console.log("Successfully obtained new OAuth token");
        } catch (error) {
            // Log detailed error for debugging
            console.error("Error getting OAuth token:", error);
            
            // Create detailed error message based on response
            let errorMsg = "Failed to authenticate";
            
            if (error.status === 404) {
                console.log("API endpoint returned 404 Not Found. Full token endpoint:", this.tokenEndpoint);
                errorMsg = "Authentication endpoint not found (404). Please check the MyMiniFactory Developer Portal for the correct API endpoint.";
                
                // Try alternate API endpoint as a fallback
                if (this.tokenEndpoint.includes("api.myminifactory.com")) {
                    this.tokenEndpoint = "https://www.myminifactory.com/api/v2/oauth/token";
                    console.log("Switching to alternate endpoint:", this.tokenEndpoint);
                    return this.getNewToken(); // Retry with new endpoint
                }
                
            } else if (error.status === 401) {
                errorMsg = "Authentication failed (401). Invalid client credentials. Please check your Client ID and Client Secret.";
            } else if (error.status === 400) {
                errorMsg = "Bad request (400). The OAuth2 request format may be incorrect.";
            } else if (error.message) {
                errorMsg = `${errorMsg}: ${error.message}`;
            }
            
            // Additional debug information about the error
            try {
                if (error.json) {
                    console.log("Error response JSON:", error.json);
                    if (error.json.error_description) {
                        errorMsg += ` (${error.json.error_description})`;
                    } else if (error.json.error) {
                        errorMsg += ` (${error.json.error})`;
                    }
                }
            } catch (e) {
                console.log("Could not parse error response as JSON");
            }
            
            console.log(`Full error details: Status=${error.status}, URL=${this.tokenEndpoint}, Message=${error.message}`);
            
            throw new Error(errorMsg);
        }
    }


    /**
     * Refresh an existing token
     */
    private async refreshToken(): Promise<void> {
        if (!this.token?.refresh_token) {
			throw new Error("No refresh token available");
        }
        
        try {
            // MyMiniFactory requires application/x-www-form-urlencoded format
            const body = new URLSearchParams();
            body.append("grant_type", "refresh_token");
            body.append("client_id", this.settings.clientId);
            body.append("client_secret", this.settings.clientSecret);
            body.append("refresh_token", this.token.refresh_token);
            
            // Convert URLSearchParams to string
            const bodyString = body.toString();
            
            const response = await requestUrl({
                url: this.tokenEndpoint,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: bodyString
            });
            
            if (response.status !== 200) {
                throw new Error(`Failed to refresh token: ${response.status} ${response.text}`);
            }
            
            // Parse response and store token
            const tokenData = response.json;
            this.token = {
                ...tokenData,
                created_at: Math.floor(Date.now() / 1000)
            };
            
            // Save token to settings
            await this.saveToken();
            
            console.log("Successfully refreshed OAuth token");
        } catch (error) {
            console.error("Error refreshing token:", error);
            throw new Error(`Failed to refresh token: ${error.message}`);
        }
    }
    
    /**
     * Save the current token to plugin settings
     */
    private async saveToken(): Promise<void> {
        if (this.token) {
            this.settings.oauthToken = JSON.stringify(this.token);
            // We need to save the settings, but this service doesn't have direct 
            // access to the plugin's saveSettings method, so we'll rely on the
            // caller to save settings after getting a token.
        }
    }
    
    /**
     * Clear the stored token
     */
    clearToken(): void {
        this.token = null;
        this.settings.oauthToken = "";
    }
}
