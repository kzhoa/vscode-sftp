export function createStaleRemoteItemError(): Error {
  return new Error('This remote item is stale. Refresh Remote Explorer and try again.');
}

export function createStaleRemoteDocumentError(): Error {
  return new Error('This remote document is stale. Refresh Remote Explorer and reopen the file.');
}
