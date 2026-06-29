import Trie from '../src/modules/serviceManager/trie';

describe('Trie', () => {
  test('getAllValues returns all inserted values', () => {
    const trie = new Trie({
      'a/b/c': 1,
      'a/b/c/d': 2,
      'a/f': 3,
      'b/c/d': 4,
    });

    const result = trie.getAllValues();
    expect(result).toEqual(expect.arrayContaining([1, 2, 3, 4]));
    expect(result.length).toEqual(4);
  });

  test('findPrefix returns shortest matching branch', () => {
    const trie = new Trie({
      a: 1,
      'a/b/c': 2,
      'd/e': 3,
    });

    expect(trie.findPrefix('a/b/test.js')).toEqual(1);
    expect(trie.findPrefix('d/e/file.txt')).toEqual(3);
    expect(trie.findPrefix('x/y/z')).toEqual(null);
  });

  test('findValuesWithShortestBranch prefers shallow matches', () => {
    const trie = new Trie({
      'a/b/c': 1,
      'a/b/c/d': 2,
      'a/f': 3,
      'b/c/e': 4,
    });

    const result = trie.findValuesWithShortestBranch();
    expect(result).toEqual(expect.arrayContaining([1, 3, 4]));
    expect(result.length).toEqual(3);
  });

  test('remove prunes empty nested branches', () => {
    const trie = new Trie({
      'a/b/c/d': 1,
      'a/b': 2,
    });

    trie.remove('a/b/c/d');

    expect(trie.findNode(trie.root, trie.splitPath('a/b'))).toBeTruthy();
    expect(trie.findNode(trie.root, trie.splitPath('a/b/c'))).toBeFalsy();
  });
});
