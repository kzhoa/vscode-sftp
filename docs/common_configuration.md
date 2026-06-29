## Common configuration

### name
A string to identify your configuration.

| Key | Value |
| --- | --- |
| *name* | *string* |

```json
{
  "name": "My Server"
}
```

### context
A path relative to the workspace root folder. <br>
Use this when you want to map a subfolder to the `remotePath`.

| Key | Value | Default |
| --- | --- | --- |
| *context* | *string* | *The workspace root.* |

```json
{
  "context": "/_subfolder_"
}
```

### protocol
Protocol to be used.

| Key | Value | Default |
| --- | --- | --- |
| *protocol* | `sftp` *or* `ftp` | `sftp` |

```json
{
  "protocol": "sftp"
}
```

### host
Hostname or IP address of the server.

| Key | Value |
| --- | --- |
| *host* | *string* |

```json
{
  "host": "server.example.com"
}
```

### port
Port number of the server.

| Key | Value |
| --- | --- |
| *port* | *integer* |

```json
{
  "port": 22
}
```

### username
Username for authentication.

| Key | Value |
| --- | --- |
| *username* | *string* |

```json
{
  "username": "user1"
}
```

### password
[!WARNING]
**Passwords are stored as plain-text!**

The password for password-based user authentication.

| Key | Value |
| --- | --- |
| *password* | *string* |

```json
{
  "password": "Password123"
}
```

### remotePath
The absolute path on the remote host.

| Key | Value | Default |
| --- | --- | --- |
| *remotePath* | *string* | `/` |

```json
{
  "remotePath": "/_subfolder_"
}
```

### filePerm
Set octal file permissions for new files.

| Key | Value | Default |
| --- | --- | --- |
| *filePerm* | *number* | `false` |

```json
{
  "filePerm": 644
}
```
 
### dirPerm
Set octal directory permissions for new directories.

| Key | Value | Default |
| --- | --- | --- |
| *dirPerm* | *number* | `false` |

```json
{
  "dirPerm": 750
}
```

### uploadOnSave
Upload on every save operation of VSCode.

| Key | Value | Default |
| --- | --- | --- |
| *uploadOnSave* | *boolean* | `false` |

```json
{
  "uploadOnSave": true
}
```

### useTempFile
Upload temp file on every save operation of VSCode to avoid breaking a webpage when a user accesses it while the file is still being uploaded (is incomplete).

| Key | Value | Default |
| --- | --- | --- |
| *useTempFile* | *boolean* | `false` |

```json
{
  "useTempFile": true
}
```

### openSsh
Enable atomic file uploads (*only supported by openSSH servers*).

| 💡 Important |
| :--- |
| *If set to* `true`*, the* `useTempFile` *option must also be set to* `true`.|

| Key | Value | Default |
| --- | --- | --- |
| *openSsh* | *boolean* | `false` |

```json
{
  "openSsh": true,
  "useTempFile": true
}
```

### downloadOnOpen
Download the file from the remote server whenever it is opened.

| Key | Value | Default |
| --- | --- | --- |
| *downloadOnOpen* | *boolean* | `false` |

```json
{
  "downloadOnOpen": true
}
```

### syncOption
Configure the behavior of the `Sync` command.

| Key | Value | Default |
| --- | --- | --- |
| *syncOption* | *object* | `{}` |

#### syncOption.create
Create files on the destination that exist only on the source.

| Key | Value | Default |
| --- | --- | --- |
| *syncOption.create* | *boolean* \| *directional object* | `true` |

#### syncOption.delete
Delete extraneous files from destination directories.

| Key | Value | Default |
| --- | --- | --- |
| *syncOption.delete* | *boolean* \| *directional object* | `false` |

#### syncOption.update
Controls whether existing files on the destination are updated.

| Key | Value | Default |
| --- | --- | --- |
| *syncOption.update* | `"always"` \| `"source-newer"` \| `"never"` \| *directional object* | `"source-newer"` |

- `"always"` — update whenever content differs (by size or mtime).
- `"source-newer"` — update only when the source mtime is newer **and** content differs.
- `"never"` — never update existing files.

#### syncOption.compare
How existing files are compared when update mode is `"source-newer"`.

| Key | Value | Default |
| --- | --- | --- |
| *syncOption.compare* | `"mtime-size"` \| `"hash"` \| *directional object* | `"mtime-size"` |

- `"mtime-size"` — compare modification time and file size.
- `"hash"` — compute SHA-256 hash of file contents for comparison.

#### Directional syntax

`create`, `delete`, `update`, and `compare` accept a directional object to set different policies for each sync direction:

```json
{
  "syncOption": {
    "delete": {
      "toRemote": true,
      "toLocal": false
    },
    "update": {
      "toRemote": "always",
      "toLocal": "source-newer"
    }
  }
}
```

When a scalar value is given, it applies to both directions.

#### syncOption.symbolicLink
How symbolic links are handled during sync.

| Key | Value | Default |
| --- | --- | --- |
| *syncOption.symbolicLink* | `"ignore"` \| `"direct"` \| `"resolve"` | `"ignore"` |

- `"ignore"` — symlinks are completely invisible to sync. They are not created, updated, deleted, or compared.
- `"direct"` — the symlink is treated as an independent meta file. It is synced by recreating the same symlink on the target side, and compared by its own mtime/size.
- `"resolve"` — the symlink is dereferenced to its target. The actual file content is synced, as if the symlink were a regular file.

##### Edge cases

**Remote symlink vs local regular file (`symbolicLink: "ignore"`, Sync Remote -> Local):**

If the remote has a symlink `foo -> bar` and local has a regular file `foo`, the sync sees the remote symlink, skips it entirely, and leaves the local file untouched. The local file will not be deleted either, because the symlink entry is removed from the comparison table before the delete phase runs.

**Remote symlink vs local regular file (`symbolicLink: "direct"`):**

The symlink and the regular file are treated as two comparable entries. The sync will attempt to update the local file with the symlink metadata, which may overwrite the local file with a symlink. Use with caution when mixing symlinks and regular files with the same name across sides.

##### Example

```json
{
  "syncOption": {
    "create": true,
    "delete": true,
    "update": "source-newer",
    "compare": "mtime-size",
    "symbolicLink": "ignore"
  }
}
```

### ignore
Ignore can be used to ignore files and folders from sync, and even supports wildcards using `*`. <br>
This is the same behavior as gitignore, all paths relative to context of the current configuration.
 
| Key | Value | Default |
| --- | --- | --- |
| *ignore* | *string[]* | `[]` |
 
```json
{
  "ignore": [
    "/.vscode",
    "/.git",
    "/.cache",
    "/_subfolder_",
    ".DS_Store",
    "*.gz",
    "*.log"
  ],
}
```

### ignoreFile
Absolute path to the ignore file or Relative path relative to the workspace root folder.
 
| Key | Value |
| --- | --- |
| *ignoreFile* | *string* |
 
```json
{
  "ignoreFile": "/.vscode/sftp.json"
}
```

### watcher
Configure the behavior of the `watcher` command.

| Key | Value | Default |
| --- | --- | --- |
| *watcher* | *object* | `{}` |

#### watcher.files
Glob patterns that are watched and when edited outside of the VSCode editor are processed.

| 💡 Important |
| :--- |
| Versions `<= 1.16.3` should set `uploadOnSave` to `false` when watching everything. From `1.17.x` onward, overlapping uploads are deduplicated by the transfer scheduler. |

| Key | Value |
| --- | --- |
| *watcher.files* | *string* |
 
#### watcher.autoUpload
Upload when the file changed.

| Key | Value |
| --- | --- |
| *watcher.autoUpload* | *boolean* |

#### watcher.autoDelete
Delete when the file is removed.

| Key | Value |
| --- | --- |
| *watcher.autoDelete* | *boolean* |
```json
{
  "watcher": {
    "files": "**/*",
    "autoUpload": true,
    "autoDelete": true
  },
}
```

### remoteTimeOffsetInHours
The number of hours difference between the local machine and the remote server (remote minus local).

| Key | Value | Default |
| --- | --- | --- |
| *remoteTimeOffsetInHours* | *number* | `0` |

```json
{
  "remoteTimeOffsetInHours": 3
}
```

### remoteExplorer
Configure the behavior of the `remoteExplorer` command.

| Key | Value | Default |
| --- | --- | --- | 
| *remoteExplorer* | *object* | `{}` |
 
#### remoteExplorer.filesExclude
Configure that patterns for excluding files and folders. <br>
The Remote Explorer decides which files and folders to show or hide based on this setting..

| Key | Value |
| --- | --- |
| *remoteExplorer.filesExclude* | *string[]* |

#### remoteExplorer.order

| Key | Value |
| --- | --- |
| *remoteExplorer.order* | *number* |
```json
{
  "remoteExplorer": {
    "filesExclude": [],
    "order": 0
  }
}
```

### concurrency
Lowering the concurrency could get more stability because some clients/servers have some sort of configured/hard coded limit.

| Key | Value | Default |
| --- | --- | --- |
| *concurrency* | *number* | `4` |

```json
{
  "concurrency": 3
}
```

### connectTimeout
The maximum connection time.

| Key | Value | Default |
| --- | --- | --- |
| *connectTimeout* | *number* | `10000` |

```json
{
  "connectTimeout": 15000
}
```

### limitOpenFilesOnRemote
Limit open file descriptors to the specific number in a remote server. <br>
Set to true for using default `limit(222)`.

| 💡 Important |
| :--- |
| *Do not set this unless you have to!* | 

| Key | Value | Default |
| --- | --- | --- |
| *limitOpenFilesOnRemote* | *mixed* | `false` |

```json
{
  "limitOpenFilesOnRemote": 15000
}
```
