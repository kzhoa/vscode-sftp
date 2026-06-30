import definitions from '../../schema/definitions.json';

describe('syncOption schema', () => {
  test('defines the new syncOption fields and removes legacy ones', () => {
    const properties = definitions.option.properties.syncOption.properties;

    expect(properties.create).toBeDefined();
    expect(properties.delete).toBeDefined();
    expect(properties.update).toBeDefined();
    expect(properties.compare).toBeDefined();
    expect(properties.skipCreate).toBeUndefined();
    expect(properties.ignoreExisting).toBeUndefined();
  });

  test('directional objects only allow toLocal and toRemote', () => {
    expect(
      definitions.definitions.directionalBooleanSyncOption.additionalProperties
    ).toEqual(false);
    expect(
      definitions.definitions.directionalUpdateSyncOption.properties
    ).toEqual({
      toLocal: {
        enum: ['always', 'source-newer', 'never', true, false, 1, 0, '1', '0'],
      },
      toRemote: {
        enum: ['always', 'source-newer', 'never', true, false, 1, 0, '1', '0'],
      },
    });
    expect(
      definitions.definitions.directionalCompareSyncOption.properties
    ).toEqual({
      toLocal: {
        enum: ['mtime-size', 'hash'],
      },
      toRemote: {
        enum: ['mtime-size', 'hash'],
      },
    });
  });
});
