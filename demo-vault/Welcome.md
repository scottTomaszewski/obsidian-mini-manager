# Mini Manager demo vault

A scratch vault for trying the plugin against the real MyMiniFactory API.

The plugin is loaded straight from the repo: `.obsidian/plugins/mini-manager` is a
symlink to the repo root, so `npm run dev` rebuilds `main.js` in place. Reload the
plugin (toggle it off and on, or restart Obsidian) to pick up a rebuild.

## First run

1. `npm install && npm run dev` in the repo root.
2. Open this folder as a vault in Obsidian and choose "Trust author and enable plugins".
3. In Settings > Mini Manager, enter your API key (and log in for paid objects).
4. Run "Mini Manager: Open Download Manager" from the command palette.

## What is and is not committed

Only this note and the handful of `.obsidian` config files are tracked. Everything
else in this vault is gitignored, including anything the plugin downloads, whatever
the download path is set to.

Credentials and plugin state live in the repo root (the plugin folder) and are also
gitignored: `data.json`, `debug.log`, `states/`, `jobs/`.
