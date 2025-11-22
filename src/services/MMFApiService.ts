import { MiniManagerSettings } from "../settings/MiniManagerSettings";
import { MMFObject, MMFSearchResponse, MMFObjectFile } from "../models/MMFObject";
import { Notice, requestUrl } from "obsidian";

export class MMFApiService {
    private apiBaseUrl = "https://www.myminifactory.com/api/v2";
    private settings: MiniManagerSettings;
    
    // Add debugging info to track API requests and responses
    private debug = true; // Set to false in production
    
    // Maximum number of retries for transient errors
    private maxRetries = 2;
    
    constructor(settings: MiniManagerSettings) {
        this.settings = settings;
    }
    
    /**
     * Makes an API request using Obsidian's requestUrl function to handle CORS issues
     * Includes retry logic with exponential backoff for transient errors
     */
    private async apiRequest(endpoint: string, method: string = 'GET', retries = 0): Promise<any> {
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
                    Attempt: ${retries + 1}/${this.maxRetries + 1}
                `);
            }
            
            const response = await requestUrl({
                url: url,
                method: method,
                headers: {
                    'accept': 'application/json'
                },
                contentType: 'application/json',
                throw: false // Don't throw on non-200 responses, we'll handle them manually
            });
            
            // Handle HTTP error status codes
            if (response.status < 200 || response.status >= 300) {
                let errorMessage = "";
                let retryable = false;
                
                switch (response.status) {
                    case 401:
                        errorMessage = "Authentication failed: please check your API key";
                        break;
                    case 403:
                        errorMessage = "Access forbidden: your API key may not have the required permissions";
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
                    console.log(`Retryable error encountered, retrying in ${delay}ms...`);
                    
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
                console.log(`Network error encountered, retrying in ${delay}ms...`);
                console.error(`Attempt ${retries + 1} failed:`, error);
                
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.apiRequest(endpoint, method, retries + 1);
            }
            
            console.error(`API request failed after ${retries + 1} attempts: ${error.message}`, error);
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
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            is_paid: false,
            download_count: 0,
            like_count: 0,
            designer: {
                name: "Unknown",
                url: "",
                username: "unknown"
            },
            images: [],
            files: [],
            _api_error: true // Special flag to indicate this is a fallback object
        };
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
            
            // Create a fallback object with minimal information and web link
            const fallbackObject = this.createFallbackObject(objectId);
            
            // If we're instructed to throw, rethrow the error
            if (this.settings.strictApiMode) {
                throw new Error(`Failed to get object details: ${error.message}`);
            }
            
            // Otherwise, return the fallback object with a warning
            console.warn(`Returning fallback object for ID ${objectId} due to API error`);
            return fallbackObject;
        }
    }
    
    async getDownloadLinks(objectId: string, useStrict: boolean = false): Promise<MMFObject> {
        try {
            console.log("Attempting to get download links through primary endpoint");
            return await this.apiRequest(`/objects/${objectId}/download-links`);
        } catch (primaryError) {
            console.warn(`Primary download links endpoint failed: ${primaryError.message}`);
            
            // Try alternative endpoints
            try {
                console.log("Trying alternative endpoint for file downloads");
                
                // Try to get the full object details which might include file URLs
                let objectDetails: MMFObject;
                
                try {
                    objectDetails = await this.getObjectById(objectId);
                } catch (objectError) {
                    console.error(`Could not get basic object details: ${objectError.message}`);
                    
                    // If strict mode is enabled, throw the error
                    if (useStrict || this.settings.strictApiMode) {
                        throw objectError;
                    }
                    
                    // Create a fallback object with website link
                    objectDetails = this.createFallbackObject(objectId);
                }
                
                // Check if we have files with URLs already
                if (objectDetails.files && 
                    Array.isArray(objectDetails.files) && 
                    objectDetails.files.some(file => file.url || file.download_url)) {
                    console.log("Found file URLs in object details");
                    return objectDetails;
                }
                
                // Try another potential endpoint format
                try {
                    console.log("Trying third endpoint format");
                    const filesData = await this.apiRequest(`/objects/${objectId}/files`);
                    
                    // If we got files data, merge it with our object
                    if (filesData && filesData.files) {
                        objectDetails.files = filesData.files;
                        return objectDetails;
                    } else if (filesData && Array.isArray(filesData)) {
                        // Handle case where the API returns an array directly
                        objectDetails.files = filesData;
                        return objectDetails;
                    } else if (filesData && 'items' in filesData && Array.isArray(filesData.items)) {
                        // Handle container with items array (new API format)
                        objectDetails.files = filesData;
                        return objectDetails;
                    } else if (filesData && 'total_count' in filesData && 'items' in filesData) {
                        // Handle another possible container format
                        objectDetails.files = filesData;
                        return objectDetails;
                    }
                    
                    return objectDetails;
                } catch (thirdError) {
                    console.warn(`Third endpoint attempt failed: ${thirdError.message}`);
                    
                    // Augment the object with web URLs for manual download
                    objectDetails.url = objectDetails.url || this.getObjectWebUrl(objectId, objectDetails.name);
                    
                    return objectDetails; // Return what we have so far
                }
            } catch (secondaryError) {
                console.error(`All download link attempts failed for object ${objectId}`);
                
                // If we're instructed to throw errors, do so
                if (useStrict || this.settings.strictApiMode) {
                    throw new Error(`Failed to get download links: API endpoints may have changed. Original error: ${primaryError.message}`);
                }
                
                // Otherwise, return a fallback object
                const fallbackObject = this.createFallbackObject(objectId);
                return fallbackObject;
            }
        }
    }
    
    /**
     * Check if the API key is valid by making a simple API request
     */
    async validateApiKey(): Promise<boolean> {
        if (!this.settings.mmfApiKey) {
            return false;
        }
        
        try {
            // Make a simple request to validate the API key
            await this.apiRequest('/objects?per_page=1');
            return true;
        } catch (error) {
            console.error("API key validation failed:", error);
            return false;
        }
    }
}
