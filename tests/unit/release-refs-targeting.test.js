const {buildConfig} = require('../../src/build-config/mageos-release-build-config');

/**
 * Release refs files may target a single repository by its build config key.
 * The key only reaches the instruction if repositoryBuildDefinition copies it,
 * and without it `releaseRefs[instruction.key]` silently resolves to undefined,
 * so every repository would fall back to the global '*' ref.
 */

// Mirrors the resolution order in src/make/mageos-release.js
const resolveRefs = (releaseRefs) => buildConfig.map(instruction => {
  let ref = instruction.ref;
  if (releaseRefs['*']) ref = releaseRefs['*'];
  if (releaseRefs[instruction.key]) ref = releaseRefs[instruction.key];
  return {key: instruction.key, ref};
});

describe('release refs targeting', () => {
  it('gives every repository a build config key', () => {
    const missing = buildConfig.filter(instruction => !instruction.key);
    expect(missing).toEqual([]);
  });

  it('uses unique keys so a per-repo override is unambiguous', () => {
    const keys = buildConfig.map(instruction => instruction.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('applies a global ref to every repository', () => {
    const resolved = resolveRefs({'*': 'release/3.x'});
    expect(resolved.every(entry => entry.ref === 'release/3.x')).toBe(true);
  });

  it('lets a single repository diverge from the global ref', () => {
    const resolved = resolveRefs({'*': 'main', magento2: 'release/3.x'});
    const magento2 = resolved.find(entry => entry.key === 'magento2');

    expect(magento2.ref).toBe('release/3.x');
    expect(resolved.filter(entry => entry.ref === 'release/3.x')).toHaveLength(1);
  });

  it('leaves refs untouched when no release refs are given', () => {
    const resolved = resolveRefs({});
    expect(resolved.find(entry => entry.key === 'magento2').ref).toBe('main');
  });
});
