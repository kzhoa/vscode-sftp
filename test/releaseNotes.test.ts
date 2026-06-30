import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractReleaseNotes } from '../scripts/extract-release-notes.mjs';

describe('extractReleaseNotes', () => {
  test('extracts the current release notes for a v-prefixed tag', () => {
    const changelog = readFileSync(resolve(__dirname, '../CHANGELOG.md'), 'utf8');
    const notes = extractReleaseNotes(changelog, 'v1.17.0');

    expect(notes).toContain('### feat');
    expect(notes).not.toContain('# Legacy Logs');
  });

  test('supports changelog headings without a v prefix', () => {
    const changelog = [
      '## 1.2.3 - 2026-01-01',
      'line one',
      '',
      '## 1.2.2 - 2025-12-31',
      'older',
    ].join('\n');

    expect(extractReleaseNotes(changelog, 'v1.2.3')).toBe('line one');
  });

  test('throws when the target release is missing', () => {
    expect(() => extractReleaseNotes('## 1.0.0 - 2026-01-01\nnotes', 'v9.9.9')).toThrow(
      'Could not find a CHANGELOG section for version "v9.9.9".'
    );
  });
});
