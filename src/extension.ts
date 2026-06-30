'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import app from './app';
import initCommands from './initCommands';
import { reportError } from './helper';
import fileActivityMonitor from './modules/fileActivityMonitor';
import { tryLoadConfigs, validateConfig } from './modules/config';
import { getBasePath, disposeAllFileServices, initConfigStoreListeners } from './modules/serviceManager';
import { getWorkspaceFolders, setContextValue } from './host';
import RemoteExplorer from './modules/remoteExplorer';

function getConnectionPoolOptions() {
  const config = vscode.workspace.getConfiguration('sftp.connectionPool');
  return {
    maxConnections: config.get<number>('maxConnections'),
    idleTimeoutMs: config.get<number>('idleTimeoutMs'),
    acquireTimeoutMs: config.get<number>('acquireTimeoutMs'),
  };
}

async function setupWorkspaceFolder(dir) {
  const configs = await tryLoadConfigs(dir);
  const entries = configs.map(rawConfig => ({
    id: getBasePath(rawConfig.context, dir),
    rawConfig,
  }));
  app.configStore.loadInitial(dir, entries, { validator: validateConfig });
}

async function setup(workspaceFolders: readonly vscode.WorkspaceFolder[]) {
  fileActivityMonitor.init();
  const results = await Promise.allSettled(
    workspaceFolders.map(folder => setupWorkspaceFolder(folder.uri.fsPath))
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      reportError(result.reason);
    }
  }
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
  try {
    initCommands(context);
  } catch (error) {
    reportError(error, 'initCommands');
  }

  const workspaceFolders = getWorkspaceFolders();
  if (!workspaceFolders) {
    return;
  }

  setContextValue('enabled', true);
  app.connectionPool.updatePolicy(getConnectionPoolOptions());
  app.sftpBarItem.show();
  app.remoteExplorer = new RemoteExplorer(context);
  let refreshScheduled = false;
  const refreshUi = () => {
    if (refreshScheduled) {
      return;
    }

    refreshScheduled = true;
    queueMicrotask(() => {
      refreshScheduled = false;

      const currentText = app.sftpBarItem.getText();
      if (currentText.startsWith('SFTP')) {
        app.sftpBarItem.reset();
      }
      if (app.remoteExplorer) {
        app.remoteExplorer.refresh();
      }
    });
  };
  initConfigStoreListeners();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('sftp.connectionPool')) {
      app.connectionPool.updatePolicy(getConnectionPoolOptions());
    }
  }));
  app.configStore.onAdded(() => refreshUi());
  app.configStore.onChanged(() => refreshUi());
  app.configStore.onRemoved(() => refreshUi());
  app.configStore.onActiveProfileChanged(() => refreshUi());
  try {
    await setup(workspaceFolders);
  } catch (error) {
    reportError(error);
  } finally {
    app.remoteExplorer.markReady();
  }
}

export async function deactivate() {
  fileActivityMonitor.destory();
  await disposeAllFileServices();
  await app.connectionPool.dispose();
}
