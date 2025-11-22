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
            // Get object details
            const object = await this.apiService.getObjectById(objectId);
            
            // Create folder structure
            const objectFolder = await this.createObjectFolder(object);
            
            // Create metadata markdown file
            await this.createMetadataFile(object, objectFolder);
            
            // Download images if enabled
            if (this.settings.downloadImages && object.images && object.images.length > 0) {
                await this.downloadImages(object, objectFolder);
            }
            
            // Download files if enabled
            if (this.settings.downloadFiles && object.files && object.files.length > 0) {
                // Get download links first
                const objectWithLinks = await this.apiService.getDownloadLinks(objectId);
                await this.downloadFiles(objectWithLinks, objectFolder);
            }
            
            new Notice(`Downloaded "${object.name}" successfully`);
        } catch (error) {
            console.error(`Error downloading object ${objectId}:`, error);
            throw new Error(`Failed to download object: ${error.message}`);
        }
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
     * Safely extract file extension from URL or provide a default
     */
    private getFileExtension(url: string | undefined): string {
        // Return default extension if URL is undefined
        if (!url) {
            console.log("Warning: Image URL is undefined, using default .jpg extension");
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
        
        // Create a download instructions file
        const instructionsPath = normalizePath(`${filesPath}/DOWNLOAD_INSTRUCTIONS.md`);
        let instructionsContent = `# MyMiniFactory Download Instructions\n\n`;
        instructionsContent += `Due to browser security restrictions, this plugin might not be able to directly download the 3D model files.\n\n`;
        instructionsContent += `## Manual Download Links\n\n`;
        
        // Download each file
        for (const file of object.files) {
            if (!file.url) {
                console.error(`No download URL for file: ${file.filename}`);
                instructionsContent += `- ${file.filename}: No download URL available\n`;
                continue;
            }
            
            instructionsContent += `- [${file.filename}](${file.url}) (${this.formatFileSize(file.filesize)})\n`;
            
            // Only attempt direct download if the setting is enabled
            if (this.settings.useDirectDownload) {
                try {
                    new Notice(`Downloading file: ${file.filename}...`);
                    
                    const response = await requestUrl({
                        url: file.url,
                        method: 'GET',
                        headers: {
                            'Cache-Control': 'no-cache',
                            'Pragma': 'no-cache',
                            'Expires': '0',
                        }
                    });
                    
                    if (response.status !== 200) {
                        new Notice(`Failed to download file: ${file.filename} (Status ${response.status})`);
                        continue;
                    }
                    
                    const filePath = normalizePath(`${filesPath}/${file.filename}`);
                    await this.app.vault.createBinary(filePath, response.arrayBuffer);
                    new Notice(`Successfully downloaded ${file.filename}`);
                } catch (error) {
                    new Notice(`Error downloading ${file.filename}: ${error.message}`);
                    console.error(`Error downloading file ${file.filename}:`, error);
                }
            }
        }
        
        // Add additional instructions
        instructionsContent += `\n## Alternative Download Methods\n\n`;
        instructionsContent += `1. **Visit the Object Page**: Go to [${object.url}](${object.url})\n`;
        instructionsContent += `2. **Log in** to your MyMiniFactory account\n`;
        instructionsContent += `3. **Download** the files directly from the website\n`;
        instructionsContent += `4. **Move the downloaded files** to this folder\n`;
        
        // Save the instructions file
        await this.app.vault.create(instructionsPath, instructionsContent);
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
