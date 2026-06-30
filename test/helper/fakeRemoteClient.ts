export function createFakeRemoteClient(fsClient: any) {
  return {
    connect: async () => undefined,
    onDisconnected: () => undefined,
    end: () => undefined,
    getFsClient: () => fsClient,
  };
}
