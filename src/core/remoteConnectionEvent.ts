export type RemoteConnectionState =
  | 'connecting'
  | 'ready'
  | 'disconnected'
  | 'failed';

export interface RemoteConnectionEvent {
  state: RemoteConnectionState;
  reason?: string;
}

export interface RemoteConnectionObserver {
  next(event: RemoteConnectionEvent): void;
}
