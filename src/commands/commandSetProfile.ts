import * as vscode from 'vscode';
import { COMMAND_SET_PROFILE } from '../constants';
import { showInformationMessage } from '../host';
import app from '../app';
import logger from '../logger';
import { checkCommand } from './abstract/createCommand';

function setProfile(profile: string | null) {
  app.configStore.setActiveProfileAll(profile);
}

export default checkCommand({
  id: COMMAND_SET_PROFILE,

  async handleCommand(definedProfile) {
    const entries = app.configStore.getAll();
    const uniqueProfiles = Array.from(
      new Set(
        entries.flatMap(entry => entry.profiles)
      )
    ).sort((left, right) => left.localeCompare(right));

    const profiles: Array<vscode.QuickPickItem & { value: string | null }> = [
      {
        value: null,
        label: 'UNSET',
      },
      ...uniqueProfiles.map(profile => {
        const supportedEntries = entries.filter(entry => entry.profiles.includes(profile));
        const isActive = supportedEntries.length > 0 &&
          supportedEntries.every(entry => app.configStore.getActiveProfile(entry.id) === profile);

        return {
          value: profile,
          label: isActive ? `${profile} (active)` : profile,
        };
      }),
    ];

    if (profiles.length <= 1) {
      showInformationMessage('No Available Profile.');
      return;
    }

    if (definedProfile !== undefined) {
      const index = profiles.findIndex(a => a.value === definedProfile);
      if (index !== -1) {
        setProfile(definedProfile);
      } else {
        logger.warn(`try to set a unknown profile "${definedProfile}"`);
      }
      return;
    }

    const item = await vscode.window.showQuickPick(profiles, { placeHolder: 'select a profile' });
    if (item === undefined) return;
    setProfile(item.value);
  },
});
