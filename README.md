# Mini Manager for Obsidian

An Obsidian plugin for downloading 3D models and their metadata from MyMiniFactory.

## Features

- Search for 3D models on MyMiniFactory directly from Obsidian
- Download STL files and images with a single click
- Automatically create a structured folder hierarchy in your vault
- Generate detailed metadata markdown files for each model
- Configure download options (images, files, etc.)

## Requirements

- A MyMiniFactory account, and the client ID of an application created in the [MMF Developer Portal](https://www.myminifactory.com/settings/developer)

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
2. Log in to MyMiniFactory (see below)
3. Configure download settings:
   - **Download Path**: Where models will be saved in your vault
   - **Download Images**: Whether to download preview images
   - **Download Files**: Whether to download STL and other model files

#### Logging in

1. Go to the [MyMiniFactory Developer Portal](https://www.myminifactory.com/settings/developer) and create an application if you don't already have one
2. Copy the application's client ID into **Client ID** in the plugin settings
3. Click **Login**. MyMiniFactory opens in your browser; authorize the application
4. Copy the full address of the page you are sent to (it contains `#access_token=...`) and paste it into **MyMiniFactory redirect URL**

The login expires after a while. When it does, downloads pause and the plugin asks you to log in again; repeat steps 3 and 4 and they resume.

##### Troubleshooting Authentication Issues

If you encounter errors when using the plugin:

1. **401 Unauthorized errors**: Your login has expired or was rejected. Log in again.
2. **403 Forbidden errors**: Your account does not have access to that object (it may be private or not purchased).
3. **404 Not Found errors**: The object ID is wrong or the object has been removed.

The plugin adds the following commands (accessible via the command palette):

- **Search MyMiniFactory Objects**: Opens a search modal to find and download models
- **Download MyMiniFactory Object by ID**: Download a specific model by its ID

### Folder Structure

Downloaded models are organized as follows:

## Development

```sh
npm install
npm run dev     # rebuild main.js on change
npm test        # unit tests (jest, no network)
npm run tsc     # type check
```

`demo-vault/` is an Obsidian vault with the plugin symlinked in from the repo root, for
trying changes against the real MyMiniFactory API. Open the folder as a vault in Obsidian;
see `demo-vault/Welcome.md`. Nothing downloaded into it is ever committed.

Tests live in `test/unit` and run against an in-memory vault and a fake MyMiniFactory
(`test/mocks`, `test/fakes`).
