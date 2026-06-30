# sftp sync extension for VS Code

Sync local files to remote servers via SFTP/FTP. Upload on save, download on open, diff, sync directories, and browse remote files — all from VS Code.

This repository is the current continuation of the VS Code SFTP extension and is now maintained by [@kzhoa](https://github.com/kzhoa/). See [Maintenance History](#maintenance-history).

## Features

- Upload/Download files and directories
- Upload on save
- Sync directory (with delete, skip, update options)
- [Browse remote files with Remote Explorer](#remote-explorer)
- Diff local and remote
- Multiple configurations and switchable profiles
- File Watcher
- Connection hopping (proxy jump)

## Installation

1. Open Extensions panel (`Ctrl+Shift+X`)
2. Search for `sftp` by `kzhoa`
3. Install and reload

Or install from: https://marketplace.visualstudio.com/items?itemName=kzhoa.sftp

## Quick Start

1. Open your project folder in VS Code
2. Run command `SFTP: Config` (`Ctrl+Shift+P` → type "sftp config")
3. Edit the generated `.vscode/sftp.json` with your server info
4. Run `SFTP: Upload Project` or enable `uploadOnSave`

## Configuration

Configuration is stored in `.vscode/sftp.json`. Below are common setups — for the full option reference, see [docs/common_configuration.md](./docs/common_configuration.md), [docs/sftp_configuration.md](./docs/sftp_configuration.md), and [docs/ftp_configuration.md](./docs/ftp_configuration.md).

### Simple (password)

```json
{
  "host": "192.168.1.100",
  "username": "deploy",
  "password": "your-password",
  "remotePath": "/var/www/project",
  "uploadOnSave": true
}
```

The `password` field is optional — if omitted, you'll be prompted on each connection.

### Private key authentication

```json
{
  "host": "server.example.com",
  "username": "deploy",
  "privateKeyPath": "~/.ssh/id_rsa",
  "remotePath": "/home/deploy/app",
  "uploadOnSave": true,
  "ignore": [".vscode", ".git", "node_modules"]
}
```

If your key has a passphrase, add `"passphrase": true` to get a prompt dialog.

### Advanced (profiles + watcher)

```json
{
  "username": "deploy",
  "privateKeyPath": "~/.ssh/id_rsa",
  "remotePath": "/var/www/project",
  "uploadOnSave": false,
  "watcher": {
    "files": "dist/**",
    "autoUpload": true,
    "autoDelete": true
  },
  "profiles": {
    "dev": {
      "host": "dev.example.com",
      "remotePath": "/var/www/dev"
    },
    "prod": {
      "host": "prod.example.com",
      "remotePath": "/var/www/prod"
    }
  },
  "defaultProfile": "dev"
}
```

Use command `SFTP: Set Profile` to switch between profiles.

_Note:_ `context` and `watcher` are only available at root level.

### Multiple Context

Map different local subdirectories to different remote paths:

```json
[
  {
    "name": "server1",
    "context": "project/build",
    "host": "host",
    "username": "deploy",
    "remotePath": "/remote/project/build"
  },
  {
    "name": "server2",
    "context": "project/src",
    "host": "host",
    "username": "deploy",
    "remotePath": "/remote/project/src"
  }
]
```

_Note:_ `name` is required in multi-context mode. Each `context` must be unique.

## Advanced Usage

### Connection Hopping

Connect to a target server through one or more jump hosts via SSH.

**Single hop** (local → hop → target):

```json
{
  "name": "target",
  "remotePath": "/path/in/target",
  "host": "hop-host",
  "username": "hop-user",
  "privateKeyPath": "/Users/localUser/.ssh/id_rsa",
  "hop": {
    "host": "target-host",
    "username": "target-user",
    "privateKeyPath": "/Users/hopUser/.ssh/id_rsa"
  }
}
```

The first `privateKeyPath` is read from your local machine; the one inside `hop` is read from the hop server.

**Multiple hops** (local → hopA → hopB → target):

```json
{
  "name": "target",
  "remotePath": "/path/in/target",
  "host": "hopA-host",
  "username": "hopA-user",
  "privateKeyPath": "~/.ssh/id_rsa",
  "hop": [
    {
      "host": "hopB-host",
      "username": "hopB-user",
      "privateKeyPath": "/home/hopA-user/.ssh/id_rsa"
    },
    {
      "host": "target-host",
      "username": "target-user",
      "privateKeyPath": "/home/hopB-user/.ssh/id_rsa"
    }
  ]
}
```

_Note:_ Variable substitution is not supported in hop configuration.

### Configuration in User Settings

You can store connection details in VS Code User Settings via [remote-fs](https://github.com/liximomo/vscode-remote-fs), then reference them in `sftp.json`:

In User Settings (`settings.json`):
```json
"remotefs.remote": {
  "dev": {
    "scheme": "sftp",
    "host": "dev.example.com",
    "username": "deploy",
    "rootPath": "/var/www/app"
  }
}
```

In `.vscode/sftp.json`:
```json
{
  "remote": "dev",
  "remotePath": "/var/www/app",
  "uploadOnSave": true,
  "ignore": [".vscode", ".git", ".DS_Store"]
}
```

## Remote Explorer

Remote Explorer lets you browse files on the remote server directly from the Activity Bar.

- Open via command `View: Show SFTP` or click the SFTP icon in the Activity Bar
- To edit a remote file locally, run `SFTP: Edit in Local`
- Multi-select with `Ctrl`/`Shift` for batch upload/download

You can set display order across multiple connections:
```json
{
  "remoteExplorer": {
    "order": 1
  }
}
```

## Debug

1. Set `sftp.debug` to `true` in VS Code Settings
2. Reload VS Code
3. View logs in `View > Output > sftp`

## Documentation

- [Common configuration reference](./docs/common_configuration.md)
- [Settings](./docs/setting.md)
- [SFTP-specific options](./docs/sftp_configuration.md)
- [FTP-specific options](./docs/ftp_configuration.md)
- [Commands](./docs/commands.md)
- [FAQ](./FAQ.md)

## Development

- Commit `package-lock.json` to keep dependency resolution reproducible across contributors and CI.
- Use `npm ci` for clean installs in CI and other reproducible environments.

## Maintenance History

This project is the current continuation of the VS Code SFTP extension:

- Originally created by [liximomo](https://github.com/liximomo) in [liximomo/vscode-sftp](https://github.com/liximomo/vscode-sftp), up to v1.0.0 (2018).
- Later maintained by [Natizyskunk](https://github.com/Natizyskunk) in [Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp), up to v1.16.3 (2023).
- Currently maintained by [@kzhoa](https://github.com/kzhoa/) in this repository.
