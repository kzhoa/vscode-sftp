import packageJson from '../package.json';

function collectCommands(entries: Array<{ command: string }> = []) {
  return entries.map(entry => entry.command);
}

describe('package contributions', () => {
  test('hide bothDirections sync command from user-facing contributions', () => {
    const commands = collectCommands(packageJson.contributes.commands);
    const commandPalette = collectCommands(
      packageJson.contributes.menus.commandPalette
    );
    const explorerContext = collectCommands(
      packageJson.contributes.menus['explorer/context']
    );

    expect(commands).not.toContain('sftp.sync.bothDirections');
    expect(commandPalette).not.toContain('sftp.sync.bothDirections');
    expect(explorerContext).not.toContain('sftp.sync.bothDirections');
  });
});
