import {
  DEFAULT_SYNC_OPTION,
  normalizeSyncOption,
  resolveSyncOptionForDirection,
  type SyncOptionInput,
} from '../../src/core/syncOption';
import { resolveSyncOption } from '../../src/core/fileServiceConfig';

describe('syncOption normalization', () => {
  test('internal defaults apply when config is absent', () => {
    const resolved = resolveSyncOption(undefined, undefined);

    expect(resolveSyncOptionForDirection(resolved, 'toLocal')).toEqual(
      DEFAULT_SYNC_OPTION
    );
    expect(resolveSyncOptionForDirection(resolved, 'toRemote')).toEqual(
      DEFAULT_SYNC_OPTION
    );
  });

  test('scalar values expand to both directions', () => {
    const normalized = normalizeSyncOption({
      create: false,
      delete: true,
      update: 'always',
      compare: 'hash',
    });

    expect(normalized).toEqual({
      create: {
        toLocal: false,
        toRemote: false,
      },
      delete: {
        toLocal: true,
        toRemote: true,
      },
      update: {
        toLocal: 'always',
        toRemote: 'always',
      },
      compare: {
        toLocal: 'hash',
        toRemote: 'hash',
      },
      symbolicLink: 'ignore',
    });
  });

  test('partial directional fields inherit lower priority values', () => {
    const resolved = resolveSyncOption(
      {
        delete: {
          toRemote: true,
        },
        compare: 'hash',
      },
      {
        delete: {
          toLocal: true,
        },
      }
    );

    expect(resolved.delete).toEqual({
      toLocal: true,
      toRemote: true,
    });
    expect(resolved.compare).toEqual({
      toLocal: 'hash',
      toRemote: 'hash',
    });
  });

  test('profile scalar overrides global directional field', () => {
    const resolved = resolveSyncOption(
      {
        delete: {
          toLocal: true,
          toRemote: false,
        },
      },
      {
        delete: false,
      }
    );

    expect(resolved.delete).toEqual({
      toLocal: false,
      toRemote: false,
    });
  });

  test('update shorthand normalizes before directional resolution', () => {
    const profileSyncOption: SyncOptionInput = {
      update: {
        toLocal: true,
        toRemote: '0',
      },
    };
    const resolved = resolveSyncOption(undefined, profileSyncOption);

    expect(resolveSyncOptionForDirection(resolved, 'toLocal').update).toEqual(
      'source-newer'
    );
    expect(resolveSyncOptionForDirection(resolved, 'toRemote').update).toEqual(
      'never'
    );
  });
});
