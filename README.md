# Mini Manager for Obsidian

An Obsidian plugin that downloads 3D models from MyMiniFactory into your vault, with their images and a note for each one.

## Features

- Queue models by ID, or by dragging their MyMiniFactory links onto the download manager
- Bulk-download a list of IDs from a file
- Downloads each model's files and images, and extracts zips
- Writes a note with frontmatter for every model, in a `<designer>/<model>` folder
- Pauses when your MyMiniFactory login expires and carries on when you log in again
- Records why a download failed, and retries failures on request
- Checks what is on disk and flags incomplete or bad downloads

## Requirements

- A MyMiniFactory account
- The client ID of an application created in the [MMF Developer Portal](https://www.myminifactory.com/settings/developer)

## Installation

1. Download `main.js`, `manifest.json` and `styles.css` from the latest [release](https://github.com/scottTomaszewski/obsidian-mini-manager/releases)
2. Put them in `<vault>/.obsidian/plugins/mini-manager/`
3. In Obsidian, go to Settings > Community plugins and enable Mini Manager

The folder must be called `mini-manager`: the plugin keeps its queue and log there.

## Logging in

1. In the [MMF Developer Portal](https://www.myminifactory.com/settings/developer), create an application if you don't already have one
2. In Settings > Mini Manager, paste the application's client ID into **Client ID**
3. Click **Login**. MyMiniFactory opens in your browser; authorize the application
4. Copy the full address of the page you are sent to (it contains `#access_token=...`) and paste it into **MyMiniFactory redirect URL**

**Test API Connection**, at the bottom of the settings, confirms the login works.

The login expires. When it does, downloads pause, the models stay in the queue, and the plugin asks you to log in again. Repeat steps 3 and 4 and they resume.

## Downloading

Open the download manager from the ribbon icon or the **Open Download Manager** command, then either:

- type one or more model IDs (separated by spaces or commas) and click **Download**, or
- drag one or more MyMiniFactory model links onto the window.

A model's ID is the number at the end of its address: `https://www.myminifactory.com/object/3d-print-goblin-12345` is `12345`.

For a long list, put the IDs, separated by commas, in `<vault>/.obsidian/plugins/mini-manager/bulk-downloads.txt` and run **Start bulk download from file**. Models already downloaded are skipped.

### What you get

```
<Download Path>/
  <Designer>/
    <Model name>/
      README.md           note with frontmatter: name, designer, tags, link, main image
      mmf-metadata.json   the model as MyMiniFactory describes it
      images/             image_1.jpg, image_2.png, ...
      files/              the model's files; zips are kept and also extracted here
```

### When a download fails

A failed model is listed in the download manager with the reason. The plugin groups failures by cause:

| Cause | What it means | What to do |
| --- | --- | --- |
| Login (401, or a login page instead of a file) | Your login expired or was rejected. Downloads pause. | Log in again; these are retried automatically. |
| 403 | Your account can't access that model or file. | Check you own it on MyMiniFactory. |
| 404 | MyMiniFactory has no such model. It may have been removed. | Check the ID or link. |
| Failed validation | **Validate Downloads** found the download incomplete or bad. | **Retry Failed**. |
| Other | Network errors, a zip that would not extract, and so on. | **Retry Failed**. |

**Retry Failed** queues every failed model again. **Clear Failed** forgets them.

If a file can't be downloaded, the plugin leaves a `MANUAL_DOWNLOAD_REQUIRED.md` note in the model's `files` folder. Put the file there by hand and retry: the model completes with your copy.

### Checking downloads

**Validate Downloads** (or the **Validate all downloaded models** command) checks every model under the download path: the note exists, the images are there, every file is there, and no zip is really a saved web page. Models that fail are marked as failed and listed, where you can select them and retry.

## Settings

| Setting | What it does |
| --- | --- |
| Client ID, Login, redirect URL | See [Logging in](#logging-in). |
| Download Path | Vault folder models are saved under. Default `MyMiniFactory`. |
| Download Images | Save each model's preview images. |
| Download Files | Save each model's files. |
| Max Retries | How many times a request is retried after a server error or rate limit. |
| Max Concurrent Downloads | How many models download their files at once. |
| Max Concurrent Light Tasks | How many models are being checked, looked up or having images fetched at once. |
| Max Concurrent Validations | How many models **Validate Downloads** checks at once. |

## Commands

- **Open Download Manager**
- **Resume Downloads**: resumes a paused queue and retries models that failed on login
- **Retry failed downloads**
- **Start bulk download from file**
- **Validate all downloaded models**
- **Re-queue active jobs**: puts every unfinished job back in the queue
- **Search MyMiniFactory Objects**: opens a search window, which is not functional at present

## Where the plugin keeps its data

Everything is in `<vault>/.obsidian/plugins/mini-manager/`:

- `data.json`: settings, including your login
- `states/`: one text file per state, listing the model IDs in it (`00_queued.txt`, `80_completed.txt`, `failure_auth.txt`, ...)
- `jobs/`: one file per model in the download manager
- `debug.log`: a log of what the plugin did, useful when something goes wrong

## Development

```sh
npm install
npm run dev     # rebuild main.js on change
npm test        # unit tests (jest, no network)
npm run tsc     # type check
```

`demo-vault/` is an Obsidian vault with the plugin symlinked in from the repo root, for trying changes against the real MyMiniFactory API. Open the folder as a vault in Obsidian; see `demo-vault/Welcome.md`. Nothing downloaded into it is ever committed.

Tests live in `test/unit` and run against an in-memory vault and a fake MyMiniFactory (`test/mocks`, `test/fakes`).

`just release <version>` sets the version, builds, commits, pushes and creates the GitHub release.
