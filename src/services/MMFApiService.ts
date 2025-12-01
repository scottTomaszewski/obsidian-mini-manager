import { MiniManagerSettings } from "../settings/MiniManagerSettings";
import { MMFObject} from "../models/MMFObject";
import { requestUrl } from "obsidian";
import { LoggerService } from "./LoggerService";
import { OAuth2Service } from "./OAuth2Service";

export class MMFApiService {
    private apiBaseUrl = "https://www.myminifactory.com/api/v2";
    private settings: MiniManagerSettings;
    private logger: LoggerService;
    private oauth2Service: OAuth2Service;
    
    // Add debugging info to track API requests and responses
    private debug = true; // Set to false in production
    
    // Maximum number of retries for transient errors
    private maxRetries = 2;
    
    constructor(settings: MiniManagerSettings, logger: LoggerService, oauth2Service: OAuth2Service) {
        this.settings = settings;
        this.logger = logger;
        this.oauth2Service = oauth2Service;
    }
    
    /**
     * Makes an API request using Obsidian's requestUrl function to handle CORS issues
     * Includes retry logic with exponential backoff for transient errors
     */
    private async apiRequest(endpoint: string, method: string = 'GET', retries = 0): Promise<any> {
        let url: string;
        const headers: Record<string, string> = {
            'accept': 'application/json'
        };

        if (this.settings.oauthToken) {
            const accessToken = await this.oauth2Service.getAccessToken();
            headers['Authorization'] = `Bearer ${accessToken}`;
            url = `${this.apiBaseUrl}${endpoint}`;
        } else {
            const separator = endpoint.includes('?') ? '&' : '?';
            url = `${this.apiBaseUrl}${endpoint}${separator}key=${this.settings.mmfApiKey}`;
        }
        
        this.logger.info(`Making API request to: ${url}`);
        
        try {
            // Debug log the API request details
            if (this.debug) {
                this.logger.debug(`API Request:
                    URL: ${url}
                    Method: ${method}
                    Attempt: ${retries + 1}/${this.maxRetries + 1}
                `);
            }
            
            const response = await requestUrl({
                url: url,
                method: method,
                headers: headers,
                contentType: 'application/json',
                throw: false // Don't throw on non-200 responses, we'll handle them manually
            });
            
            // Handle HTTP error status codes
            if (response.status < 200 || response.status >= 300) {
                let errorMessage = "";
                let retryable = false;
                
                switch (response.status) {
                    case 401:
                        errorMessage = "Authentication failed: please check your API key or OAuth token";
                        break;
                    case 403:
                        errorMessage = "Access forbidden: your API key or OAuth token may not have the required permissions";
                        break;
                    case 404:
                        errorMessage = `Resource not found: ${endpoint}`;
                        break;
                    case 429:
                        errorMessage = "Rate limit exceeded: too many requests";
                        retryable = true;
                        break;
                    case 500:
                    case 502:
                    case 503:
                    case 504:
                        errorMessage = `Server error (${response.status}): the API service might be experiencing issues`;
                        retryable = true;
                        break;
                    default:
                        errorMessage = `API error: ${response.status}`;
                }
                
                // Try to add more details from the response if available
                try {
                    if (response.json && response.json.error) {
                        errorMessage += ` - ${response.json.error}`;
                        if (response.json.error_description) {
                            errorMessage += `: ${response.json.error_description}`;
                        }
                    } else if (response.text) {
                        const trimmedText = response.text.substring(0, 100);
                        errorMessage += ` - ${trimmedText}${response.text.length > 100 ? '...' : ''}`;
                    }
                } catch (e) {
                    // If parsing fails, just use the status message
                }
                
                // Retry logic for retryable errors
                if (retryable && retries < this.maxRetries) {
                    const delay = Math.pow(2, retries) * 1000; // Exponential backoff
                    this.logger.warn(`Retryable error encountered, retrying in ${delay}ms...`);
                    
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.apiRequest(endpoint, method, retries + 1);
                }
                
                throw new Error(errorMessage);
            }
            
            return response.json;
        } catch (error) {
            // For network errors or other issues, also implement retry logic
            if (retries < this.maxRetries && 
                (error.message.includes('Failed to fetch') || 
                 error.message.includes('NetworkError') || 
                 error.message.includes('network') ||
                 error.message.includes('timeout'))) {
                
                const delay = Math.pow(2, retries) * 1000; // Exponential backoff
                this.logger.warn(`Network error encountered, retrying in ${delay}ms...`);
                this.logger.error(`Attempt ${retries + 1} failed: ${error.message}`);
                
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.apiRequest(endpoint, method, retries + 1);
            }
            
            this.logger.error(`API request failed after ${retries + 1} attempts: ${error.message}`);
            throw new Error(`API request failed: ${error.message}`);
        }
    }
    
    /**
     * Generate a web URL for a MyMiniFactory object
     */
    public getObjectWebUrl(objectId: string, objectName?: string): string {
        if (objectName) {
            const slug = objectName.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
            return `https://www.myminifactory.com/object/${slug}-${objectId}`;
        } else {
            return `https://www.myminifactory.com/object/${objectId}`;
        }
    }
    
    /**
     * Create a fallback object with minimal information when API fails
     */
    private createFallbackObject(objectId: string): MMFObject {
        return {
            id: objectId,
            name: `Object ${objectId}`,
            description: "Unable to retrieve object details from the API",
            url: this.getObjectWebUrl(objectId),
            images: [],
            files: {
                total_count: 0,
                items: [],
            }
        };
    }
    
    async searchObjects(query: string, page: number = 1, perPage: number = 10): Promise<MMFObject[]> {
        try {
            const data = await this.apiRequest(`/objects?q=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}`);
            return data.objects || [];
        } catch (error) {
            this.logger.error(`Error searching MMF objects: ${error.message}`);
            throw new Error(`Failed to search objects: ${error.message}`);
        }
    }
    
    async getObjectById(objectId: string): Promise<MMFObject> {
        try {
            return await this.apiRequest(`/objects/${objectId}`);
        		} catch (error) {
        			this.logger.error(`Error getting object ${objectId}: ${error.message}`);
        			if (error.message.includes("MyMiniFactory access token missing or expired")) {
        				throw error;
        			}
        			
        			// Create a fallback object with minimal information and web link
        			const fallbackObject = this.createFallbackObject(objectId);
        			
        			// If we're instructed to throw, rethrow the error
        			if (this.settings.strictApiMode) {
        				throw new Error(`Failed to get object details: ${error.message}`);
        			}
        			
        			// Otherwise, return the fallback object with a warning
        			this.logger.warn(`Returning fallback object for ID ${objectId} due to API error`);
        			return fallbackObject;
        		}    }

    /**
     * Check if the API key is valid by making a simple API request
     */
    async validateApiKey(): Promise<boolean> {
        if (!this.settings.mmfApiKey && !this.settings.oauthToken) {
            this.logger.warn("API Key and OAuth Token are both missing. Cannot validate API connection.");
            return false;
        }
        
        try {
            // Make a simple request to validate the API key
            // If oauthToken is available, it will be used by apiRequest
            await this.apiRequest('/objects?per_page=1');
            this.logger.info("API key/OAuth token validation successful.");
            return true;
        } catch (error) {
            this.logger.error(`API key/OAuth token validation failed: ${error.message}`);
            return false;
        }
    }
}
