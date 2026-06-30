import type { ExtensionContext } from 'vscode';
import logger from './logger';
import { registerCommand } from './host';
import Command from './commands/abstract/command';
import { createCommand, createFileCommand, createFileMultiCommand } from './commands/abstract/createCommand';
import commandCancelAllTransfer from './commands/commandCancelAllTransfer';
import commandClearChecked from './commands/commandClearChecked';
import commandConfig from './commands/commandConfig';
import commandListActiveFolder from './commands/commandListActiveFolder';
import commandOpenSshConnection from './commands/commandOpenSshConnection';
import commandSetProfile from './commands/commandSetProfile';
import commandToggleOutputPanel from './commands/commandToggleOutputPanel';
import commandUploadChangedFiles from './commands/commandUploadChangedFiles';
import fileCommandCreateFile from './commands/fileCommandCreateFile';
import fileCommandCreateFolder from './commands/fileCommandCreateFolder';
import fileCommandDeleteRemote from './commands/fileCommandDeleteRemote';
import fileCommandDiff from './commands/fileCommandDiff';
import fileCommandDiffActiveFile from './commands/fileCommandDiffActiveFile';
import fileCommandDownload from './commands/fileCommandDownload';
import fileCommandDownloadActiveFile from './commands/fileCommandDownloadActiveFile';
import fileCommandDownloadActiveFolder from './commands/fileCommandDownloadActiveFolder';
import fileCommandDownloadFile from './commands/fileCommandDownloadFile';
import fileCommandDownloadFolder from './commands/fileCommandDownloadFolder';
import fileCommandDownloadForce from './commands/fileCommandDownloadForce';
import fileCommandDownloadProject from './commands/fileCommandDownloadProject';
import fileCommandEditInLocal from './commands/fileCommandEditInLocal';
import fileCommandList from './commands/fileCommandList';
import fileCommandListAll from './commands/fileCommandListAll';
import fileCommandRevealInExplorer from './commands/fileCommandRevealInExplorer';
import fileCommandRevealInRemoteExplorer from './commands/fileCommandRevealInRemoteExplorer';
import fileCommandSyncLocalToRemote from './commands/fileCommandSyncLocalToRemote';
import fileCommandSyncRemoteToLocal from './commands/fileCommandSyncRemoteToLocal';
import fileCommandUpload from './commands/fileCommandUpload';
import fileCommandUploadActiveFile from './commands/fileCommandUploadActiveFile';
import fileCommandUploadActiveFolder from './commands/fileCommandUploadActiveFolder';
import fileCommandUploadFile from './commands/fileCommandUploadFile';
import fileCommandUploadFolder from './commands/fileCommandUploadFolder';
import fileCommandUploadForce from './commands/fileCommandUploadForce';
import fileCommandUploadProject from './commands/fileCommandUploadProject';
import fileMultiCommandUploadActiveFileToAllProfiles from './commands/fileMultiCommandUploadActiveFileToAllProfiles';
import fileMultiCommandUploadActiveFolderToAllProfiles from './commands/fileMultiCommandUploadActiveFolderToAllProfiles';
import fileMultiCommandUploadFileToAllProfiles from './commands/fileMultiCommandUploadFileToAllProfiles';
import fileMultiCommandUploadFolderToAllProfiles from './commands/fileMultiCommandUploadFolderToAllProfiles';
import fileMultiCommandUploadForceToAllProfiles from './commands/fileMultiCommandUploadForceToAllProfiles';
import fileMultiCommandUploadProjectToAllProfiles from './commands/fileMultiCommandUploadProjectToAllProfiles';
import fileMultiCommandUploadToAllProfiles from './commands/fileMultiCommandUploadToAllProfiles';

const commandOptions = [
  ['./commands/commandCancelAllTransfer.ts', commandCancelAllTransfer],
  ['./commands/commandClearChecked.ts', commandClearChecked],
  ['./commands/commandConfig.ts', commandConfig],
  ['./commands/commandListActiveFolder.ts', commandListActiveFolder],
  ['./commands/commandOpenSshConnection.ts', commandOpenSshConnection],
  ['./commands/commandSetProfile.ts', commandSetProfile],
  ['./commands/commandToggleOutputPanel.ts', commandToggleOutputPanel],
  ['./commands/commandUploadChangedFiles.ts', commandUploadChangedFiles],
] as const;

const fileCommandOptions = [
  ['./commands/fileCommandCreateFile.ts', fileCommandCreateFile],
  ['./commands/fileCommandCreateFolder.ts', fileCommandCreateFolder],
  ['./commands/fileCommandDeleteRemote.ts', fileCommandDeleteRemote],
  ['./commands/fileCommandDiff.ts', fileCommandDiff],
  ['./commands/fileCommandDiffActiveFile.ts', fileCommandDiffActiveFile],
  ['./commands/fileCommandDownload.ts', fileCommandDownload],
  ['./commands/fileCommandDownloadActiveFile.ts', fileCommandDownloadActiveFile],
  ['./commands/fileCommandDownloadActiveFolder.ts', fileCommandDownloadActiveFolder],
  ['./commands/fileCommandDownloadFile.ts', fileCommandDownloadFile],
  ['./commands/fileCommandDownloadFolder.ts', fileCommandDownloadFolder],
  ['./commands/fileCommandDownloadForce.ts', fileCommandDownloadForce],
  ['./commands/fileCommandDownloadProject.ts', fileCommandDownloadProject],
  ['./commands/fileCommandEditInLocal.ts', fileCommandEditInLocal],
  ['./commands/fileCommandList.ts', fileCommandList],
  ['./commands/fileCommandListAll.ts', fileCommandListAll],
  ['./commands/fileCommandRevealInExplorer.ts', fileCommandRevealInExplorer],
  ['./commands/fileCommandRevealInRemoteExplorer.ts', fileCommandRevealInRemoteExplorer],
  ['./commands/fileCommandSyncLocalToRemote.ts', fileCommandSyncLocalToRemote],
  ['./commands/fileCommandSyncRemoteToLocal.ts', fileCommandSyncRemoteToLocal],
  ['./commands/fileCommandUpload.ts', fileCommandUpload],
  ['./commands/fileCommandUploadActiveFile.ts', fileCommandUploadActiveFile],
  ['./commands/fileCommandUploadActiveFolder.ts', fileCommandUploadActiveFolder],
  ['./commands/fileCommandUploadFile.ts', fileCommandUploadFile],
  ['./commands/fileCommandUploadFolder.ts', fileCommandUploadFolder],
  ['./commands/fileCommandUploadForce.ts', fileCommandUploadForce],
  ['./commands/fileCommandUploadProject.ts', fileCommandUploadProject],
] as const;

const fileMultiCommandOptions = [
  ['./commands/fileMultiCommandUploadActiveFileToAllProfiles.ts', fileMultiCommandUploadActiveFileToAllProfiles],
  ['./commands/fileMultiCommandUploadActiveFolderToAllProfiles.ts', fileMultiCommandUploadActiveFolderToAllProfiles],
  ['./commands/fileMultiCommandUploadFileToAllProfiles.ts', fileMultiCommandUploadFileToAllProfiles],
  ['./commands/fileMultiCommandUploadFolderToAllProfiles.ts', fileMultiCommandUploadFolderToAllProfiles],
  ['./commands/fileMultiCommandUploadForceToAllProfiles.ts', fileMultiCommandUploadForceToAllProfiles],
  ['./commands/fileMultiCommandUploadProjectToAllProfiles.ts', fileMultiCommandUploadProjectToAllProfiles],
  ['./commands/fileMultiCommandUploadToAllProfiles.ts', fileMultiCommandUploadToAllProfiles],
] as const;

export default function init(context: ExtensionContext) {
  loadCommands(commandOptions, /command(.*)/, createCommand, context);
  loadCommands(fileCommandOptions, /fileCommand(.*)/, createFileCommand, context);
  loadCommands(fileMultiCommandOptions, /fileMultiCommand(.*)/, createFileMultiCommand, context);
}

function nomalizeCommandName(rawName) {
  const firstLetter = rawName[0].toUpperCase();
  return firstLetter + rawName.slice(1).replace(/[A-Z]/g, token => ` ${token[0]}`);
}

function loadCommands(commandModules, nameRegex, commandCreator, context: ExtensionContext) {
  commandModules.forEach(([fileName, commandOption]) => {
    const clearName = fileName
      .replace(/^\.\//, '')
      .replace(/\.\w+$/, '');

    const match = nameRegex.exec(clearName);
    if (!match || !match[1]) {
      logger.warn(`Command name not found from ${fileName}`);
      return;
    }
    commandOption.name = nomalizeCommandName(match[1]);

    try {
      // tslint:disable-next-line variable-name
      const Cmd = commandCreator(commandOption);
      const cmdInstance: Command = new Cmd();
      logger.debug(`register command "${commandOption.name}" from "${fileName}"`);
      registerCommand(context, commandOption.id, cmdInstance.run, cmdInstance);
    } catch (error) {
      logger.error(error, `load command "${fileName}"`);
    }
  });
}
