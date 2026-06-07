const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const [, , x64ManifestPath, arm64ManifestPath, outputPath] = process.argv;

if (!x64ManifestPath || !arm64ManifestPath || !outputPath) {
  console.error(
    'Usage: node scripts/merge-mac-update-manifests.cjs <x64-yml> <arm64-yml> <output-yml>',
  );
  process.exit(2);
}

function readManifest(manifestPath) {
  const absolutePath = path.resolve(manifestPath);
  const manifest = yaml.load(fs.readFileSync(absolutePath, 'utf8'), {
    schema: yaml.JSON_SCHEMA,
  });
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Invalid update manifest: ${absolutePath}`);
  }
  if (!manifest.version || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`Update manifest is missing version or files: ${absolutePath}`);
  }
  return manifest;
}

const manifests = [readManifest(x64ManifestPath), readManifest(arm64ManifestPath)];
const versions = new Set(manifests.map((manifest) => manifest.version));
if (versions.size !== 1) {
  throw new Error(`Cannot merge manifests with different versions: ${[...versions].join(', ')}`);
}

const filesByUrl = new Map();
for (const manifest of manifests) {
  for (const file of manifest.files) {
    if (!file?.url || !file?.sha512) {
      throw new Error(`Manifest ${manifest.version} contains an invalid file entry.`);
    }
    const existing = filesByUrl.get(file.url);
    if (existing && JSON.stringify(existing) !== JSON.stringify(file)) {
      throw new Error(`Conflicting metadata for ${file.url}`);
    }
    filesByUrl.set(file.url, file);
  }
}

const primary = manifests.find((manifest) => String(manifest.path).includes('x64')) || manifests[0];
const releaseDates = manifests
  .map((manifest) => manifest.releaseDate)
  .filter(Boolean)
  .sort();

const merged = {
  ...primary,
  files: [...filesByUrl.values()],
};
if (releaseDates.length > 0) {
  merged.releaseDate = releaseDates.at(-1);
}

fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(
  path.resolve(outputPath),
  yaml.dump(merged, {
    schema: yaml.JSON_SCHEMA,
    forceQuotes: true,
    lineWidth: -1,
    noRefs: true,
    quotingType: "'",
  }),
);

console.log(
  `[update-manifest] merged ${merged.files.length} files for version ${merged.version} into ${path.resolve(outputPath)}.`,
);
