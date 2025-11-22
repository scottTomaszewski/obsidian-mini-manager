import { MiniManagerSettings } from "../settings/MiniManagerSettings";
import { MMFObject, MMFSearchResponse } from "../models/MMFObject";
import { Notice, requestUrl } from "obsidian";

export class MMFApiService {
    private apiBaseUrl = "https://www.myminifactory.com/api/v2";
    private settings: MiniManagerSettings;
    
    // Add debugging info to track API requests and responses
    private debug = true; // Set to false in production
    
    constructor(settings: MiniManagerSettings) {
        this.settings = settings;
    }
    
    /**
     * Makes an API request using Obsidian's requestUrl function to handle CORS issues
     */
    private async apiRequest(endpoint: string, method: string = 'GET'): Promise<any> {
        // Add API key as query parameter
        const separator = endpoint.includes('?') ? '&' : '?';
        const url = `${this.apiBaseUrl}${endpoint}${separator}key=${this.settings.mmfApiKey}`;
        console.log(`Making API request to: ${url}`);
        
        try {
            // Debug log the API request details
            if (this.debug) {
                console.log(`API Request:
                    URL: ${url}
                    Method: ${method}
                `);
            }
            
            const response = await requestUrl({
                url: url,
                method: method,
                headers: {
                    'accept': 'application/json'
                },
                contentType: 'application/json',
            });
            
            if (response.status < 200 || response.status >= 300) {
                if (response.status === 401) {
                    throw new Error("Authentication failed: please check your API key");
                } else if (response.status === 403) {
                    throw new Error("Access forbidden: your API key may not have the required permissions");
                } else if (response.status === 404) {
                    throw new Error(`Resource not found: ${endpoint}`);
                } else if (response.status === 429) {
                    throw new Error("Rate limit exceeded: too many requests");
                }
                
                // Generic error with response details if available
                let errorMessage = `API error: ${response.status}`;
                try {
                    // Try to parse error details from response
                    if (response.json && response.json.error) {
                        errorMessage += ` - ${response.json.error}`;
                        if (response.json.error_description) {
                            errorMessage += `: ${response.json.error_description}`;
                        }
                    } else if (response.text) {
                        errorMessage += ` - ${response.text}`;
                    }
                } catch (e) {
                    // If parsing fails, just use the status
                }
                
                throw new Error(errorMessage);
            }
            
            return response.json;
        } catch (error) {
            console.error(`API request failed: ${error.message}`, error);
            throw new Error(`API request failed: ${error.message}`);
        }
    }
    
    async searchObjects(query: string, page: number = 1, perPage: number = 10): Promise<MMFObject[]> {
        try {
            const data = await this.apiRequest(`/objects?q=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}`);
            return data.objects || [];
        } catch (error) {
            console.error("Error searching MMF objects:", error);
            throw new Error(`Failed to search objects: ${error.message}`);
        }
    }
    
    async getObjectById(objectId: string): Promise<MMFObject> {
        try {
            return await this.apiRequest(`/objects/${objectId}`);
        } catch (error) {
            console.error(`Error getting object ${objectId}:`, error);
            throw new Error(`Failed to get object details: ${error.message}`);
        }
    }
    
    async getDownloadLinks(objectId: string): Promise<MMFObject> {
        try {
            return await this.apiRequest(`/objects/${objectId}/download-links`);
        } catch (error) {
            console.error(`Error getting download links for object ${objectId}:`, error);
            throw new Error(`Failed to get download links: ${error.message}`);
        }
    }
}
