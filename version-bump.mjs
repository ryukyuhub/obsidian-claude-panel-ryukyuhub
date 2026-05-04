// Run by `npm version <semver>` (via the "version" script in package.json).
// Syncs the new version into manifest.json and appends an entry to
// versions.json mapping plugin version → minAppVersion. npm itself
// stages, commits, and tags afterwards.
import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
	console.error(
		"npm_package_version is not set; run via `npm version <semver>`."
	);
	process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const minAppVersion = manifest.minAppVersion;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

let versions = {};
try {
	versions = JSON.parse(readFileSync("versions.json", "utf8"));
} catch {
	/* missing or malformed — start fresh */
}
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`Bumped to ${targetVersion} (minAppVersion: ${minAppVersion})`);
