release version:
	jq '.version = "{{version}}"' manifest.json > tmp && mv tmp manifest.json
	jq '.version = "{{version}}"' package.json > tmp && mv tmp package.json
	npm run build-no-check
	gh release create "{{version}}" main.js manifest.json styles.css
