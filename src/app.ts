import StatusBarItem from './ui/statusBarItem';
import { registerStatusBarUpdater } from './ui/output';
import { COMMAND_TOGGLE_OUTPUT } from './constants';
import { ConfigStore } from './core/configStore';
import { ConnectionPool } from './core/connectionPool';
import { defaultConfigSource } from './modules/configSourceImpl';
import type RemoteExplorer from './modules/remoteExplorer';

interface App {
  configStore: ConfigStore;
  connectionPool: ConnectionPool;
  sftpBarItem: StatusBarItem;
  remoteExplorer: RemoteExplorer;
}

const app: App = Object.create(null);

app.configStore = new ConfigStore(defaultConfigSource);
app.connectionPool = new ConnectionPool();
app.sftpBarItem = new StatusBarItem(
  () => {
    const profileEntries = app.configStore.getAll().filter(entry =>
      Object.keys(entry.rawConfig.profiles || {}).length > 0
    );
    const activeProfiles = profileEntries.map(entry => app.configStore.getActiveProfile(entry.id));

    if (activeProfiles.length === 0 || activeProfiles.every(profile => profile === null)) {
      return 'SFTP';
    }

    const firstActiveProfile = activeProfiles[0];
    if (
      firstActiveProfile !== null &&
      activeProfiles.every(profile => profile === firstActiveProfile)
    ) {
      return `SFTP: ${firstActiveProfile}`;
    }

    return 'SFTP: Mixed';
  },
  'SFTP@kzhoa',
  COMMAND_TOGGLE_OUTPUT
);
registerStatusBarUpdater(status => app.sftpBarItem.updateStatus(status));

export default app;
