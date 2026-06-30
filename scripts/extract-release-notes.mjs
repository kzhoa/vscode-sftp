import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractReleaseNotes(changelog, rawVersion) {
  const version = rawVersion.startsWith('v') ? rawVersion.slice(1) : rawVersion;
  const headingPattern = new RegExp(
    `^##\\s+(?:v)?${escapeRegex(version)}(?:\\s+-\\s+.+)?$`,
    'm'
  );
  const match = headingPattern.exec(changelog);

  if (!match || match.index === undefined) {
    throw new Error(
      `Could not find a CHANGELOG section for version "${rawVersion}".`
    );
  }

  const sectionStart = match.index + match[0].length;
  const rest = changelog.slice(sectionStart);
  const nextHeadingIndex = rest.search(/^(?:##\s+|#\s+)/m);
  const section = (nextHeadingIndex === -1 ? rest : rest.slice(0, nextHeadingIndex)).trim();

  if (!section) {
    throw new Error(
      `CHANGELOG section for version "${rawVersion}" is empty.`
    );
  }

  return section;
}

async function main() {
  const [rawVersion, changelogPath = './CHANGELOG.md', outputPath] = process.argv.slice(2);

  if (!rawVersion) {
    throw new Error('Usage: node scripts/extract-release-notes.mjs <version> [changelogPath] [outputPath]');
  }

  const changelog = await fs.readFile(changelogPath, 'utf8');
  const releaseNotes = extractReleaseNotes(changelog, rawVersion);

  if (outputPath) {
    await fs.writeFile(outputPath, `${releaseNotes}\n`);
    return;
  }

  process.stdout.write(`${releaseNotes}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
