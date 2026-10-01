# Changelog

## 0.0.45

- "Validate Downloads" now marks bad downloads as failed, so "Retry Failed" and bulk download pick them up instead of treating them as completed
- A placeholder folder under `Unknown/` is removed when the same model also has a real download, which is the one that gets checked
- Notes left for images that failed to download are no longer counted as images
- Removes the "Direct Download Method" setting: files are always downloaded when "Download Files" is on
- A zip that cannot be extracted now fails the model instead of completing it
- Rewrites the README

## 0.0.44

- Fixes objects being saved as `Unknown/Object <id>` and marked complete when the MyMiniFactory login had expired or the API call failed. Such failures now fail the object instead
- Downloads pause, with objects left in the queue, when the login has expired; logging in again resumes them and retries the objects that failed on authentication
- Adds "Retry failed downloads" (command and download manager button)
- "Validate all" now flags existing `Unknown/Object <id>` placeholder folders so they can be retried
- An object is only ever in one state; fixes ids being lost from, or duplicated across, the state files
- Fixes downloads stalling between stages until "Resume Downloads" was run
- File and image download errors are recorded with their HTTP status
- A 403 (from the API or for a file) now fails only that object instead of pausing all downloads
- Retrying an object keeps files placed by hand after a `MANUAL_DOWNLOAD_REQUIRED.md` notice
- Objects requested while downloads are paused are queued instead of dropped
- Fixes URLs dropped on the download manager occasionally not being queued while the job list was updating
- Honours the Max Retries setting; removes the Strict API Mode setting
- Credentials are no longer written to `debug.log`
- Removes the API key and client secret settings; the MyMiniFactory login is the only way to authenticate
- Fixes "Test API Connection" always reporting failure: it called an endpoint the API does not have
- The Login button asks for a client ID when none is set, instead of opening MyMiniFactory's "Client not found" page
- Adds a test suite and a demo vault

## 0.0.43

- Allows configuration of max validation threads

## 0.0.42

- Validation workers throttled to avoid performance issues

## 0.0.41

- Validation workers run concurrently

## 0.0.40

- Validation on web worker

## 0.0.39

- Helper command to requeue stuck jobs

## 0.0.38

- Adjusting how retries are handled

## 0.0.37

- Better handling and performance of validation

## 0.0.36

- Better handling of 403s

## 0.0.33

- Better stats

## 0.0.32

- Better handling of illegal characters in files

## 0.0.31

- Corrects stats handling

## 0.0.30

- Adds stats

## 0.0.29

- Handles issue with disabled "clear completed" button

## 0.0.28

- Handles semi-deadlock issue with "clear completed" button

## 0.0.27

- Tasks yield more often to allow other elements to run to improve performance

## 0.0.26

- Better performance when many items are queued

## 0.0.25

- Addresses more performance issues

## 0.0.24

- Better performance interacting with all.txt

## 0.0.23

- Hitting "resume downloads" will check queue for newly added model ids

## 0.0.22

- Bunch of fixes to the handling of the lifecycle of a model

## 0.0.21

- Aa bit more stability to avoid data loss

## 0.0.20

- Allows for resuming downloads regardless of state

## 0.0.18

- Fixes to state management

## 0.0.16

- Switches to a file-based approach for managing downloads

## 0.0.15

- Checks for empty downloads
- Less aggressive notifications

## 0.0.14

- Fixing download issues

## 0.0.13

- Better validation and fixes retry button issue

## 0.0.12

- Attempts to fix arrayBuffer issue
- Avoids downloading any models over 1.5GB

## 0.0.11

- Adds more info to buttons
- Better handling of repeat downloads
- Adds bulk download feature (create `bulk-downloads.txt` in the plugin's root dir)

## 0.0.10

- Faster validation

## 0.0.9

- Better error handling

## 0.0.6

- Should correctly handle 403s

## 0.0.5

- validation improvements
- attempts to fix on-startup crash

## 0.0.3

- Correctly errors on 403
- debug file at correct location

## 0.0.2

- Initial release

