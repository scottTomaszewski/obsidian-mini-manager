import { App, Notice, TFile, TFolder, normalizePath, requestUrl } from "obsidian";
import { MiniManagerSettings } from "../settings/MiniManagerSettings";
import { MMFApiService } from "./MMFApiService";
import { MMFObject, MMFObjectFile, MMFObjectImage } from "../models/MMFObject";

export class MMFDownloader {
    private app: App;
    private settings: MiniManagerSettings;
    private apiService: MMFApiService;
    
    constructor(app: App, settings: MiniManagerSettings) {
        this.app = app;
        this.settings = settings;
        this.apiService = new MMFApiService(settings);
    }
    
    async downloadObject(objectId: string): Promise<void> {
        try {
                console.log(`Starting download for object ID: ${objectId}`);
                
                // Track what was successfully downloaded
                let objectDetailsRetrieved = false;
                let imagesDownloaded = false;
                let filesDownloaded = false;
                let errorMessages = [];
                
                // Get object details
                let object: MMFObject;
                try {
                    object = await this.apiService.getObjectById(objectId);
                    console.log(`Retrieved object details for "${object.name}"`);
                    objectDetailsRetrieved = true;
                } catch (objectError) {
                    console.error(`Failed to get object details: ${objectError.message}`);
                    errorMessages.push(`Object retrieval error: ${objectError.message}`);
                    
                    // Create a minimal object with the ID for fallback
                    object = {
                        id: objectId,
                        name: `MyMiniFactory Object ${objectId}`,
                        description: "Unable to retrieve details from the API. This could be due to API changes, authentication issues, or the object may not exist.",
                        url: `https://www.myminifactory.com/object/${objectId}`,
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
                        files: []
                    };
                }
                
                // Create folder structure - even with minimal object
                const objectFolder = await this.createObjectFolder(object);
                
                // Create metadata markdown file with what we have
                await this.createMetadataFile(object, objectFolder, !objectDetailsRetrieved);
                
                // If we couldn't even get object details and strict mode is on, stop here
                if (!objectDetailsRetrieved && this.settings.strictApiMode) {
                    throw new Error(`Failed to retrieve object details for ID ${objectId}`);
                }
                
                // Download images if enabled and we have object details
                if (this.settings.downloadImages && objectDetailsRetrieved) {
                    try {
                        console.log("Attempting to download images...");
                        await this.downloadImages(object, objectFolder);
                        imagesDownloaded = true;
                    } catch (imageError) {
                        console.error("Error downloading images:", imageError);
                        errorMessages.push(`Images download error: ${imageError.message}`);
                    }
                }
                
                // Download files if enabled
                if (this.settings.downloadFiles) {
                    try {
                        console.log("Attempting to download 3D model files...");

                        // First check if the object already contains file URLs
                        let objectWithFiles = object;
                        let hasFileUrls = false;
                        
                        if (objectWithFiles.files && objectWithFiles.files.items && objectWithFiles.files.items.length > 0) {
							// Handle container with items array
							hasFileUrls = objectWithFiles.files.items.some(file =>
								file.download_url && typeof file.download_url === 'string');
							console.log("Object already contains file URLs, using existing data");
                        }
                        
                        // Make sure we have a web URL for manual downloads
                        if (!objectWithFiles.url) {
                            const slug = objectWithFiles.name 
                                ? encodeURIComponent(objectWithFiles.name.toLowerCase().replace(/\s+/g, '-'))
                                : objectId;
                            objectWithFiles.url = `https://www.myminifactory.com/object/${slug}-${objectId}`;
                        }
                        
                        // Ensure files is an array before proceeding
                        if (!objectWithFiles.files.items || !Array.isArray(objectWithFiles.files.items)) {
                            objectWithFiles.files.items = [];
                            console.warn("Files property is not an array, initializing as empty array");
                        }
                        
                        // Try to download files or at least create instructions
                        await this.downloadFiles(objectWithFiles, objectFolder);
                        filesDownloaded = true;
                    } catch (filesError) {
                        console.error("Error downloading files:", filesError);
                        errorMessages.push(`Files download error: ${filesError.message}`);
                        
                        // Create fallback download instructions even if everything fails
                        try {
                            await this.createEmergencyInstructions(objectId, object, objectFolder, filesError);
                        } catch (instructionsError) {
                            console.error("Failed to create instructions file:", instructionsError);
                        }
                    }
                }
                
                // Prepare completion message
                let status = "";
                if (objectDetailsRetrieved) {
                    status = "details";
                    if (imagesDownloaded) status += " + images";
                    if (filesDownloaded) status += " + files";
                } else {
                    status = "minimal info only";
                }
                
                let message = `Processed "${object.name}" (${status})`;
                
                if (errorMessages.length > 0) {
                    message += " with errors";
                    console.warn("Download completed with errors:", errorMessages);
                }
                
                new Notice(message);
            } catch (error) {
                console.error(`Error downloading object ${objectId}:`, error);
                
                // Create a minimal placeholder and instructions if possible
                try {
                    const baseFolder = normalizePath(this.settings.downloadPath);
                    const objectFolder = normalizePath(`${baseFolder}/object_${objectId}`);
                    
                    // Create the folder structure if it doesn't exist
                    if (!await this.folderExists(baseFolder)) {
                        await this.app.vault.createFolder(baseFolder);
                    }
                    
                    if (!await this.folderExists(objectFolder)) {
                        await this.app.vault.createFolder(objectFolder);
                    }
                    
                    // Create emergency instructions
                    const instructionsPath = normalizePath(`${objectFolder}/API_ERROR.md`);
                    let content = `# MyMiniFactory API Error\n\n`;
                    content += `## Error Details\n\n`;
                    content += `Failed to download object ID: ${objectId}\n\n`;
                    content += `Error: ${error.message}\n\n`;
                    content += `Time: ${new Date().toLocaleString()}\n\n`;
                    content += `## Possible Solutions\n\n`;
                    content += `1. **Check your API key** in the plugin settings\n`;
                    content += `2. **Verify the object ID** is correct: ${objectId}\n`;
                    content += `3. **Try again later** as this might be a temporary API issue\n`;
                    content += `4. **Visit the object directly** on MyMiniFactory: [Object ${objectId}](https://www.myminifactory.com/object/${objectId})\n`;
                    content += `5. **Check for plugin updates** as the API might have changed\n\n`;
                    content += `## Manual Download\n\n`;
                    content += `If the API continues to fail, you can manually download the object:\n\n`;
                    content += `1. Visit [MyMiniFactory](https://www.myminifactory.com)\n`;
                    content += `2. Search for the object ID: ${objectId}\n`;
                    content += `3. Download the files manually\n`;
                    content += `4. Place them in the files subfolder of this directory\n`;
                    
                    await this.app.vault.create(instructionsPath, content);
                } catch (emergencyError) {
                    console.error("Failed to create emergency instructions:", emergencyError);
                }
                
                throw new Error(`Failed to download object: ${error.message}`);
            }
        }
        
        /**
         * Create emergency download instructions when everything else fails
         */
        private async createEmergencyInstructions(
            objectId: string,
            object: MMFObject,
            objectFolder: string,
            error: Error
        ): Promise<void> {
            const filesPath = normalizePath(`${objectFolder}/files`);
            if (!await this.folderExists(filesPath)) {
                await this.app.vault.createFolder(filesPath);
            }
            
            // Ensure we have a web URL for manual downloads
            const webUrl = object.url || `https://www.myminifactory.com/object/${objectId}`;
            
            const instructionsPath = normalizePath(`${filesPath}/MANUAL_DOWNLOAD_REQUIRED.md`);
            let instructionsContent = `# Manual Download Required\n\n`;
            instructionsContent += `The plugin encountered API errors when downloading "${object.name || `Object ${objectId}`}".\n\n`;
            
            instructionsContent += `## About This Object\n\n`;
            instructionsContent += `- **Object ID**: ${objectId}\n`;
            if (object.name) instructionsContent += `- **Name**: ${object.name}\n`;
            if (object.designer && object.designer.name) instructionsContent += `- **Designer**: ${object.designer.name}\n`;
            
            instructionsContent += `\n## Steps to Download Files\n\n`;
            instructionsContent += `1. Visit the object page on MyMiniFactory: [${object.name || `Object ${objectId}`}](${webUrl})\n`;
            instructionsContent += `2. Log in to your MyMiniFactory account\n`;
            instructionsContent += `3. Use the download button on the website\n`;
            instructionsContent += `4. Save the files to this folder\n\n`;
            
            instructionsContent += `## Technical Details\n\n`;
            instructionsContent += `Error: ${error.message}\n\n`;
            instructionsContent += `Time: ${new Date().toLocaleString()}\n\n`;
            instructionsContent += `This error may be due to one or more of the following:\n\n`;
            instructionsContent += `- API changes or outage at MyMiniFactory\n`;
            instructionsContent += `- The object ID may be incorrect\n`;
            instructionsContent += `- The object may require purchase\n`;
            instructionsContent += `- Your API key may not have sufficient permissions\n`;
            instructionsContent += `- The object may have been removed or made private\n\n`;
            
            instructionsContent += `Try updating the plugin or checking the [MyMiniFactory API documentation](https://www.myminifactory.com/settings/developer) for more information.`;
            
            await this.app.vault.create(instructionsPath, instructionsContent);
            console.log("Created emergency download instructions file");
    }
    
    private async createObjectFolder(object: MMFObject): Promise<string> {
        // Create base download folder if it doesn't exist
        const basePath = normalizePath(this.settings.downloadPath);
        if (!await this.folderExists(basePath)) {
            await this.app.vault.createFolder(basePath);
        }
        
        // Create designer folder
        const designerPath = normalizePath(`${basePath}/${this.sanitizePath(object.designer.name)}`);
        if (!await this.folderExists(designerPath)) {
            await this.app.vault.createFolder(designerPath);
        }
        
        // Create object folder
        const objectPath = normalizePath(`${designerPath}/${this.sanitizePath(object.name)}`);
        if (!await this.folderExists(objectPath)) {
            await this.app.vault.createFolder(objectPath);
        }
        
        return objectPath;
    }
    
    private async createMetadataFile(object: MMFObject, folderPath: string): Promise<void> {
        const filePath = normalizePath(`${folderPath}/README.md`);
        
        let content = `# ${object.name}\n\n`;
        content += `![Main Image](${object.images[0]?.url || ""})\n\n`;
        content += `## Designer: ${object.designer.name}\n\n`;
        content += `- **Published:** ${new Date(object.publishedAt).toLocaleDateString()}\n`;
        content += `- **MMF URL:** [${object.url}](${object.url})\n`;
        content += `- **License:** ${object.license || "Not specified"}\n`;
        content += `- **Downloads:** ${object.downloadsCount}\n`;
        content += `- **Likes:** ${object.likesCount}\n\n`;
        
        content += `## Description\n\n${object.description}\n\n`;
        
        if (object.tags && object.tags.length > 0) {
            content += `## Tags\n\n`;
            object.tags.forEach(tag => {
                content += `- ${tag}\n`;
            });
            content += '\n';
        }
        
        if (object.categories && object.categories.length > 0) {
            content += `## Categories\n\n`;
            object.categories.forEach(category => {
                content += `- ${category}\n`;
            });
            content += '\n';
        }
        
        if (object.files && object.files.length > 0) {
            content += `## Files\n\n`;
            object.files.forEach(file => {
                content += `- ${file.filename} (${this.formatFileSize(file.filesize)})\n`;
            });
        }
        
        await this.app.vault.create(filePath, content);
    }
    
    /**
     * Safely extract file extension from URL or provide a default
     */
    private getFileExtension(url: string | undefined): string {
        // Return default extension if URL is undefined
        if (!url) {
            console.log("Warning: Image URL is undefined, using default .jpg extension");
            return ".jpg";
        }
    
        try {
            // Try to extract extension from URL
            const matches = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
            if (matches && matches.length > 1) {
                return `.${matches[1].toLowerCase()}`;
            }
            
            // For URLs without extensions or unexpected formats, use a default
            console.log(`No file extension found in URL: ${url}, using default .jpg extension`);
            return ".jpg";
        } catch (error) {
            console.error(`Error extracting file extension from URL: ${url}`, error);
            return ".jpg";
        }
    }
    
    /**
     * Extract image URL from MyMiniFactory image object based on API response structure
     */
    private getImageUrl(image: any): string | undefined {
        console.log("Processing image:", JSON.stringify(image, null, 2));
        
        // If image is already a string URL, return it directly
        if (typeof image === 'string' && image.startsWith('http')) {
            return image;
        }
        
        // Make sure we have an object to work with
        if (!image || typeof image !== 'object') {
            return undefined;
        }
        
        // Handle the complex nested structure from the API
        // Prefer larger image formats when available
        if (image.large && image.large.url) {
            return image.large.url;
        } else if (image.standard && image.standard.url) {
            return image.standard.url;
        } else if (image.original && image.original.url) {
            return image.original.url;
        } else if (image.thumbnail && image.thumbnail.url) {
            return image.thumbnail.url;
        } else if (image.tiny && image.tiny.url) {
            return image.tiny.url;
        }
        
        // Handle direct URL in url property
        if (typeof image.url === 'string' && image.url.startsWith('http')) {
            return image.url;
        }
        
        // Recursively search through properties looking for URL strings
        for (const key in image) {
            const value = image[key];
            
            // If it's a string URL, return it
            if (typeof value === 'string' && value.startsWith('http')) {
                return value;
            }
            
            // If it's an object with a url property, return that
            if (value && typeof value === 'object' && typeof value.url === 'string' && value.url.startsWith('http')) {
                return value.url;
            }
        }
        
        // No URL found
        return undefined;
    }
    
    /**
     * Extract file download URL from MMF file object
     * Handles different possible structures from the API
     */
    private getFileDownloadUrl(file: any): string | undefined {
        console.log("Processing file for download:", JSON.stringify(file, null, 2));
        
        if (!file) {
            return undefined;
        }
        
        // Direct case: already a string URL
        if (typeof file === 'string' && file.startsWith('http')) {
            return file;
        }
        
        // Most direct case: download_url property
        if (file.download_url && typeof file.download_url === 'string' && file.download_url.startsWith('http')) {
            return file.download_url;
        }
        
        // Next case: url property
        if (file.url && typeof file.url === 'string' && file.url.startsWith('http')) {
            return file.url;
        }
        
        // Special case: look for download links in a nested structure
        if (file.links && file.links.download && typeof file.links.download === 'string') {
            return file.links.download;
        }
        
        // Search recursively through properties
        for (const key in file) {
            const value = file[key];
            
            // If it's a string URL, return it
            if (typeof value === 'string' && value.startsWith('http')) {
                if (key.includes('url') || key.includes('download') || key.includes('link')) {
                    return value;
                }
            }
            
            // If it's an object, look for url or download properties
            if (value && typeof value === 'object') {
                // Check for url properties first
                if (value.download_url && typeof value.download_url === 'string') {
                    return value.download_url;
                }
                if (value.url && typeof value.url === 'string') {
                    return value.url;
                }
                
                // Deeper search for keys that might contain urls
                for (const subKey in value) {
                    if (typeof value[subKey] === 'string' && value[subKey].startsWith('http')) {
                        if (subKey.includes('url') || subKey.includes('download') || subKey.includes('link')) {
                            return value[subKey];
                        }
                    }
                }
            }
        }
        
        return undefined;
    }
    
    /**
     * Safely extract file extension from URL or provide a default
     */
    private getFileExtension(url: string | undefined): string {
        // Return default extension if URL is undefined
        if (!url) {
            console.log("Warning: URL is undefined, using default .jpg extension");
            return ".jpg";
        }
    
        try {
            // Try to extract extension from URL string
            const matches = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
            if (matches && matches.length > 1) {
                return `.${matches[1].toLowerCase()}`;
            }
            
            // For URLs without extensions or unexpected formats, use a default
            console.log(`No file extension found in URL: ${url}, using default .jpg extension`);
            return ".jpg";
        } catch (error) {
            console.error(`Error extracting file extension from URL: ${url}`, error);
            return ".jpg";
        }
    }
    
    private async downloadImages(object: MMFObject, folderPath: string): Promise<void> {
        console.log("Processing object for images:", object.id, object.name);
        
        // Create images folder
        const imagesPath = normalizePath(`${folderPath}/images`);
        if (!await this.folderExists(imagesPath)) {
            await this.app.vault.createFolder(imagesPath);
        }
        
        // Check if images array exists and handle it
        if (object.images) {
            // The API returns images as an array of complex objects
            const imageArray = Array.isArray(object.images) ? object.images : [object.images];
            
            console.log(`Found ${imageArray.length} images in the object`);
            
            if (imageArray.length === 0) {
                console.log("Empty images array for object", object.id);
            } else {
                // Download each image
                for (let i = 0; i < imageArray.length; i++) {
                    const image = imageArray[i];
                    console.log(`Processing image ${i+1}/${imageArray.length}`);
                    
                    const imageUrl = this.getImageUrl(image);
                    
                    if (!imageUrl) {
                        console.log(`Could not determine URL for image ${i+1}`);
                        continue;
                    }
                    
                    await this.downloadSingleImage(imageUrl, imagesPath, `image_${i+1}`);
                }
            }
        } else {
            console.log("No images array found for object", object.id);
            
            // Fallback options if no images array is found
            if (object.image) {
                console.log("Found single image property, trying to use it");
                const imageUrl = this.getImageUrl(object.image);
                if (imageUrl) {
                    await this.downloadSingleImage(imageUrl, imagesPath, "main_image");
                }
            } else if (object.thumbnail_url) {
                console.log("Found thumbnail URL, trying to use it");
                await this.downloadSingleImage(object.thumbnail_url, imagesPath, "thumbnail");
            }
        }
        
        // If we still have no images, create a placeholder
        const files = await this.app.vault.adapter.list(imagesPath);
        if (files && files.files.length === 0) {
            console.log("No images were downloaded, creating placeholder");
            const placeholderPath = normalizePath(`${imagesPath}/no_images.md`);
            const placeholderContent = `# No Images Available\n\nNo images could be downloaded for this object.\n\nPlease visit the original page to view images:\n${object.url}`;
            await this.app.vault.create(placeholderPath, placeholderContent);
        }
    }
    
    /**
     * Download a single image given its URL
     */
    private async downloadSingleImage(url: string, folderPath: string, baseFileName: string): Promise<boolean> {
        try {
            const fileName = `${baseFileName}${this.getFileExtension(url)}`;
            const filePath = normalizePath(`${folderPath}/${fileName}`);
            
            new Notice(`Downloading ${baseFileName}...`);
            console.log(`Downloading image from URL: ${url}`);
            
            const response = await requestUrl({
                url: url,
                method: 'GET',
                headers: {
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'Expires': '0',
                }
            });
            
            if (response.status !== 200) {
                new Notice(`Failed to download image: ${response.status}`);
                return false;
            }
            
            await this.app.vault.createBinary(filePath, response.arrayBuffer);
            console.log(`Successfully downloaded ${baseFileName}`);
            return true;
        } catch (error) {
            new Notice(`Error downloading ${baseFileName}: ${error.message}`);
            console.error(`Error downloading image ${url}:`, error);
            
            // Create a placeholder file with instructions if download fails
            const placeholderPath = normalizePath(`${folderPath}/${baseFileName}_error.md`);
            const placeholderContent = `# Download Error\n\nFailed to download image from: ${url}\n\nError: ${error.message}\n\nPlease visit the MyMiniFactory website to view this image.`;
            await this.app.vault.create(placeholderPath, placeholderContent);
            return false;
        }
    }
    
    private async downloadFiles(object: MMFObject, folderPath: string): Promise<void> {
        // Create files folder
        const filesPath = normalizePath(`${folderPath}/files`);
        if (!await this.folderExists(filesPath)) {
            await this.app.vault.createFolder(filesPath);
        }
        
        // Download each file
        for (const item of object.files.items) {
            if (!item.download_url) {
                console.error(`No download URL for file: ${item.filename}`);
                continue;
            }
            
            // Only attempt direct download if the setting is enabled
            if (this.settings.useDirectDownload) {
                try {
                    new Notice(`Downloading file: ${item.filename}...`);
                    
                    const response = await requestUrl({
                        url: item.download_url,
                        method: 'GET',
                        headers: {
                            'Cache-Control': 'no-cache',
                            'Pragma': 'no-cache',
                            'Expires': '0',
                        }
                    });
                    
                    if (response.status !== 200) {
                        new Notice(`Failed to download file: ${item.filename} (Status ${response.status})`);
                        continue;
                    }
                    
                    const filePath = normalizePath(`${filesPath}/${item.filename}`);
                    await this.app.vault.createBinary(filePath, response.arrayBuffer);
                    new Notice(`Successfully downloaded ${item.filename}`);
                } catch (error) {
                    new Notice(`Error downloading ${item.filename}: ${error.message}`);
                    console.error(`Error downloading file ${item.filename}:`, error);
                }
            } else {
				console.log(`Skipping direct download for file ${item.filename}`);
			}
        }
    }
    
    // Helper methods
    private async folderExists(path: string): Promise<boolean> {
        try {
            const folder = this.app.vault.getAbstractFileByPath(path);
            return folder instanceof TFolder;
        } catch (error) {
            return false;
        }
    }
    
    private sanitizePath(path: string): string {
        return path.replace(/[\\/:*?"<>|]/g, '_').trim();
    }
    
    private getFileExtension(url: string): string {
        const match = url.match(/\.(jpg|jpeg|png|gif|webp)($|\?)/i);
        return match ? `.${match[1].toLowerCase()}` : '.jpg';
    }
    
    private formatFileSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }
}
