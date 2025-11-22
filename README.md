# Mini Manager for Obsidian

An Obsidian plugin for downloading 3D models and their metadata from MyMiniFactory.

## Features

- Search for 3D models on MyMiniFactory directly from Obsidian
- Download STL files and images with a single click
- Automatically create a structured folder hierarchy in your vault
- Generate detailed metadata markdown files for each model
- Configure download options (images, files, etc.)

## Requirements

- A valid MyMiniFactory API key (get one from the [MMF Developer Portal](https://www.myminifactory.com/settings/developer))

## Installation

1. In Obsidian, go to Settings > Community plugins
2. Disable Safe mode if it's enabled
3. Click "Browse" and search for "Mini Manager"
4. Install the plugin and enable it

### CORS Limitations

Due to browser security restrictions (CORS policy), the plugin may encounter some limitations when downloading files directly from MyMiniFactory. The plugin provides two approaches to handle this:

1. **API metadata access**: The plugin can still retrieve object information, generate metadata, and create organized folder structures.

2. **Manual download links**: For the actual model files, the plugin generates a markdown file with direct download links that you can use in your browser.

These limitations are due to how web browsers handle cross-origin requests and are not specific to this plugin.

### Manual Installation

1. Download the latest release from the [GitHub releases page](https://github.com/yourusername/obsidian-mini-manager/releases)
2. Extract the ZIP file to your Obsidian plugins folder: `<vault>/.obsidian/plugins/`
3. Enable the plugin in Obsidian settings

## Usage

### Configuration

1. Go to Settings > Mini Manager
2. Enter your MyMiniFactory API key:
   - **API Key**: Your API key from MMF Developer Portal
3. Configure download settings:
   - **Download Path**: Where models will be saved in your vault
   - **Download Images**: Whether to download preview images
   - **Download Files**: Whether to download STL and other model files

#### Getting Your API Key

1. Go to the [MyMiniFactory Developer Portal](https://www.myminifactory.com/settings/developer)
2. Create a new application if you don't already have one
3. Set the Application Name to "Obsidian Mini Manager"
4. Copy your API key to the plugin settings
5. Your API key should look something like: `39aa3e2d-ee2b-4cc5-bc94-a152875478a3`

The plugin uses API key authentication for MyMiniFactory API, which is simpler and more reliable than OAuth2.

##### Troubleshooting Authentication Issues

If you encounter errors when using the plugin:

1. **404 Not Found errors**: Ensure you're using the latest version of the plugin, as API endpoints may have changed.
2. **401 Unauthorized errors**: Verify your API key is correct and not expired.
3. **403 Forbidden errors**: Check that your application has the proper permissions enabled on the MMF Developer Portal.
4. **Restart Obsidian**: Some changes require a restart of Obsidian to take effect.

You can test your API key with this curl command:

The plugin adds the following commands (accessible via the command palette):

- **Search MyMiniFactory Objects**: Opens a search modal to find and download models
- **Download MyMiniFactory Object by ID**: Download a specific model by its ID

### Folder Structure

Downloaded models are organized as follows:
