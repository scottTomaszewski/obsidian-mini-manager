# Changelog

## 1.3.1
- Fixed "object.files is not iterable" error when downloading models
- Updated MMFObject interface to handle new API response format for files
- Improved handling of API responses with nested file structures
- Added support for the files.items[] array format from base object endpoint
- Enhanced safety checks for file downloads

## 1.3.0
- Added robust API error recovery for handling 404 errors
- Implemented retry mechanism with exponential backoff for transient API failures
- Created emergency metadata generation when API access completely fails
- Added new settings for API behavior control:
  - Strict API Mode option to control error handling behavior
  - Max Retries setting for customizing retry attempts
  - Test Connection button to validate API key
- Improved offline mode with complete website fallback for all API failures
- Updated documentation with troubleshooting section

## 1.2.0
- Fixed 404 error when downloading 3D model files
- Added improved fallback mechanism for API endpoint changes
- Enhanced error handling for file downloads
- Created more comprehensive download instructions
- Improved handling of model files with missing download links

## 1.1.0
- Switched from OAuth2 to API Key authentication for more reliable connection
- Simplified settings UI
- Fixed 404 authentication errors

## 1.0.0
- Initial release

