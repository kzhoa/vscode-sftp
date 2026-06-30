import { vi } from 'vitest';
import { Uri, __setPendingMessageResult } from 'vscode';
import downloadFileCommand from '../../src/commands/fileCommandDownloadFile';
import downloadFolderCommand from '../../src/commands/fileCommandDownloadFolder';
import deleteRemoteCommand from '../../src/commands/fileCommandDeleteRemote';
import forceDownloadCommand from '../../src/commands/fileCommandDownloadForce';
import { UResource } from '../../src/core';

const { remoteExplorerMock } = vi.hoisted(() => ({
  remoteExplorerMock: {
    hasCheckedItems: vi.fn(),
    getCheckedItems: vi.fn(),
    clearCheckedItems: vi.fn(),
  },
}));

vi.mock('../../src/app', () => ({
  default: {
    remoteExplorer: remoteExplorerMock,
  },
}));

function createRemoteItem(remotePath: string, isDirectory = false) {
  return {
    resource: UResource.makeResource({
      remote: { host: 'example.com', port: 22 },
      fsPath: remotePath,
      remoteId: 1,
    }),
    isDirectory,
  };
}

describe('checked remote explorer commands', () => {
  beforeEach(() => {
    remoteExplorerMock.hasCheckedItems.mockReset();
    remoteExplorerMock.getCheckedItems.mockReset();
    remoteExplorerMock.clearCheckedItems.mockReset();
    remoteExplorerMock.hasCheckedItems.mockReturnValue(false);
  });

  test('download file command keeps explicit remote item target', () => {
    const clicked = createRemoteItem('/remote/clicked.txt');
    const checked = createRemoteItem('/remote/checked.txt');
    remoteExplorerMock.hasCheckedItems.mockReturnValue(true);
    remoteExplorerMock.getCheckedItems.mockReturnValue([checked]);

    const result = downloadFileCommand.getFileTarget(clicked, [clicked]);

    expect(result).toEqual([clicked.resource.uri]);
  });

  test('download folder command keeps explicit remote directory target', () => {
    const clicked = createRemoteItem('/remote/folder', true);
    const root = {
      ...createRemoteItem('/remote', true),
      explorerContext: {
        id: 1,
      },
    };
    remoteExplorerMock.hasCheckedItems.mockReturnValue(true);
    remoteExplorerMock.getCheckedItems.mockReturnValue([root]);

    const result = downloadFolderCommand.getFileTarget(clicked, [clicked]);

    expect(result).toEqual([clicked.resource.uri]);
  });

  test('force download uses checked items when invoked without explicit target', () => {
    const parent = createRemoteItem('/remote/folder', true);
    const child = createRemoteItem('/remote/folder/file.txt');
    remoteExplorerMock.hasCheckedItems.mockReturnValue(true);
    remoteExplorerMock.getCheckedItems.mockReturnValue([child, parent]);

    const result = forceDownloadCommand.getFileTarget(undefined, undefined);

    expect(result).toEqual([parent.resource.uri]);
  });

  test('delete remote keeps explicit target even when checked roots exist', async () => {
    const clicked = createRemoteItem('/remote/folder', true);
    const root = {
      ...createRemoteItem('/remote', true),
      explorerContext: {
        id: 1,
      },
    };
    remoteExplorerMock.hasCheckedItems.mockReturnValue(true);
    remoteExplorerMock.getCheckedItems.mockReturnValue([root]);
    __setPendingMessageResult({ title: 'Delete' });

    await expect(deleteRemoteCommand.getFileTarget(clicked, [clicked])).resolves.toEqual([clicked.resource.uri]);
  });

  test('delete remote rejects checked roots when invoked from checked batch state', async () => {
    const root = {
      ...createRemoteItem('/remote', true),
      explorerContext: {
        id: 1,
      },
    };
    remoteExplorerMock.hasCheckedItems.mockReturnValue(true);
    remoteExplorerMock.getCheckedItems.mockReturnValue([root]);

    await expect(deleteRemoteCommand.getFileTarget(undefined, undefined)).rejects.toThrow(
      'Checked roots are not supported for this command.'
    );
  });

  test('download file command ignores checked state outside remote explorer context', () => {
    remoteExplorerMock.hasCheckedItems.mockReturnValue(true);
    remoteExplorerMock.getCheckedItems.mockReturnValue([createRemoteItem('/remote/checked.txt')]);
    const localUri = Uri.file('/workspace/file.txt');

    const result = downloadFileCommand.getFileTarget(localUri);

    expect(result).toEqual(localUri);
  });
});
