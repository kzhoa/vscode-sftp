import app from '../app';
import { COMMAND_REMOTEEXPLORER_CLEAR_CHECKED } from '../constants';
import { checkCommand } from './abstract/createCommand';

export default checkCommand({
  id: COMMAND_REMOTEEXPLORER_CLEAR_CHECKED,

  handleCommand() {
    app.remoteExplorer?.clearCheckedItems();
  },
});
