import { vi } from 'vitest';
import * as vscode from 'vscode';
import app from '../../../src/app';
import RemoteExplorer from '../../../src/modules/remoteExplorer/explorer';

const fileService = {
  baseDir: '/workspace',
  name: 'Main',
  getAvailableProfiles: () => [],
  getInvalidProfiles: () => [],
  getConfig: () => ({
    host: 'example.com',
    port: 22,
    remotePath: '/remote',
    remoteExplorer: {
      order: 0,
      filesExclude: [],
    },
  }),
};

vi.mock('../../../src/modules/serviceManager', () => ({
  getAllFileService: () => [fileService],
  getFileService: () => fileService,
}));

describe('RemoteExplorer checkbox state', () => {
  beforeEach(() => {
    vscode.__resetMock();
  });

  test('tracks checked items and clears them from toolbar command state', async () => {
    const explorer = new RemoteExplorer({ subscriptions: [] } as any);
    app.remoteExplorer = explorer as any;
    explorer.markReady();

    const treeView = vscode.__getMockState().treeViews[0];
    const provider = treeView.options.treeDataProvider;
    const [root] = await provider.getChildren();

    expect(provider.getTreeItem(root).checkboxState.state).toBe(vscode.TreeItemCheckboxState.Unchecked);

    treeView.__fireCheckboxState([[root, vscode.TreeItemCheckboxState.Checked]]);

    expect(provider.getTreeItem(root).checkboxState.state).toBe(vscode.TreeItemCheckboxState.Checked);
    expect(treeView.badge).toEqual({ value: 1, tooltip: '1 checked item(s)' });
    expect(vscode.__getMockState().contextValues['sftp.remoteExplorer.hasCheckedItems']).toBe(true);

    explorer.clearCheckedItems();

    expect(provider.getTreeItem(root).checkboxState.state).toBe(vscode.TreeItemCheckboxState.Unchecked);
    expect(treeView.badge).toBeUndefined();
    expect(vscode.__getMockState().contextValues['sftp.remoteExplorer.hasCheckedItems']).toBe(false);
  });

  test('refresh command prefers checked items over transient tree selection', async () => {
    const explorer = new RemoteExplorer({ subscriptions: [] } as any);
    app.remoteExplorer = explorer as any;
    explorer.markReady();

    const treeView = vscode.__getMockState().treeViews[0];
    const provider = treeView.options.treeDataProvider;
    const [root] = await provider.getChildren();
    const selectionItem = {
      resource: root.resource,
      isDirectory: true,
    };
    treeView.selection = [selectionItem];
    treeView.__fireCheckboxState([[root, vscode.TreeItemCheckboxState.Checked]]);

    const refreshSpy = vi.spyOn(explorer, 'refresh').mockImplementation(() => undefined as any);
    const refreshCommand = vscode.__getMockState().registeredCommands.get('sftp.remoteExplorer.refresh');

    await refreshCommand?.();

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith(root);
  });

  test('stale checked items are pruned and synced from the visible UI state', async () => {
    const explorer = new RemoteExplorer({ subscriptions: [] } as any);
    app.remoteExplorer = explorer as any;
    explorer.markReady();

    const treeView = vscode.__getMockState().treeViews[0];
    const provider = treeView.options.treeDataProvider;
    const [root] = await provider.getChildren();

    treeView.__fireCheckboxState([[root, vscode.TreeItemCheckboxState.Checked]]);
    vi.spyOn(provider, 'resolveCheckedItem').mockReturnValue(null);

    expect(explorer.getCheckedItems()).toEqual([]);
    expect(explorer.hasCheckedItems()).toBe(false);
    expect(treeView.badge).toBeUndefined();
    expect(vscode.__getMockState().contextValues['sftp.remoteExplorer.hasCheckedItems']).toBe(false);
  });

  test('findRoot stays a pure lookup before roots are initialized', () => {
    const explorer = new RemoteExplorer({ subscriptions: [] } as any);
    app.remoteExplorer = explorer as any;

    const treeView = vscode.__getMockState().treeViews[0];
    const provider = treeView.options.treeDataProvider;
    const remoteUri = vscode.Uri.parse('remote://example.com:22/remote?remoteId=1&fsPath=%2Fremote');

    expect(provider.findRoot(remoteUri)).toBeNull();
  });
});
