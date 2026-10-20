const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  generateReleaseRefs,
  latestLineTag,
  nextPatchVersion,
  renderRefsFile,
} = require('../../src/release-refs-generator');

const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-history-'));
fs.writeFileSync(path.join(historyDir, '2.3.0.json'), '{}');

const buildConfig = [
  {key: 'magento2', repoUrl: 'https://github.com/mage-os/mageos-magento2.git', fromTag: '1.0.0'},
  {key: 'inventory', repoUrl: 'https://github.com/mage-os/mageos-inventory.git', fromTag: '1.0.0'},
  {key: 'magento-zf-soap', repoUrl: 'https://github.com/mage-os/mageos-magento-zf-soap.git', fromTag: '3.0.0'},
];

const fakeGit = ({tags = ['2.2.2', '2.3.0', '3.6.0', 'release/2.x-as-shipped'], branches = {}} = {}) => ({
  listTags: async () => tags,
  hasBranch: async url => url in branches,
  commitsAhead: async url => branches[url],
});

describe('latestLineTag', () => {
  it('picks the newest release of the major and skips non-semver tags', () => {
    expect(latestLineTag(['2.2.2', '2.10.0', '2.3.0', '3.6.0', 'release/2.x-as-shipped', '2.4.0-beta1'], 2)).toBe('2.10.0');
  });

  it('returns null when the major has no release', () => {
    expect(latestLineTag(['3.6.0'], 2)).toBeNull();
  });
});

describe('nextPatchVersion', () => {
  it('increments the patch number', () => {
    expect(nextPatchVersion('2.3.0')).toBe('2.3.1');
    expect(nextPatchVersion('2.3.9')).toBe('2.3.10');
  });
});

describe('renderRefsFile', () => {
  it('writes a loadable refs and pins file', () => {
    const file = path.join(historyDir, 'rendered.js');
    fs.writeFileSync(file, renderRefsFile({version: '2.3.1', baseline: '2.3.0', refs: {magento2: 'release/2.x'}}));
    expect(require(file)).toEqual({refs: {'*': '2.3.0', magento2: 'release/2.x'}, pins: {}});
  });
});

describe('generateReleaseRefs', () => {
  it('names a branch only for repositories with commits past the baseline', async () => {
    const result = await generateReleaseRefs({
      major: 2,
      buildConfig,
      historyDir,
      git: fakeGit({branches: {
        'https://github.com/mage-os/mageos-magento2.git': 8,
        'https://github.com/mage-os/mageos-inventory.git': 0,
      }}),
    });
    expect(result.version).toBe('2.3.1');
    expect(result.baseline).toBe('2.3.0');
    expect(result.refs).toEqual({magento2: 'release/2.x'});
  });

  it('skips repositories that are not part of the release', async () => {
    const asked = [];
    const git = fakeGit({branches: {'https://github.com/mage-os/mageos-magento2.git': 1}});
    const hasBranch = git.hasBranch;
    git.hasBranch = async (url, branch) => { asked.push(url); return hasBranch(url, branch); };
    await generateReleaseRefs({major: 2, buildConfig, historyDir, git});
    expect(asked).not.toContain('https://github.com/mage-os/mageos-magento-zf-soap.git');
  });

  it('refuses the newest major', async () => {
    await expect(generateReleaseRefs({major: 3, buildConfig, historyDir, git: fakeGit()}))
      .rejects.toThrow('newest released major');
  });

  it('refuses when no line branch has anything to release', async () => {
    await expect(generateReleaseRefs({major: 2, buildConfig, historyDir, git: fakeGit()}))
      .rejects.toThrow('nothing to release');
  });

  it('refuses a baseline without a history file', async () => {
    await expect(generateReleaseRefs({major: 2, buildConfig, historyDir, git: fakeGit({tags: ['2.3.1', '3.6.0']})}))
      .rejects.toThrow('no history file for 2.3.1');
  });

  it('refuses a version that is tagged or does not follow the baseline', async () => {
    const git = fakeGit({branches: {'https://github.com/mage-os/mageos-magento2.git': 1}});
    await expect(generateReleaseRefs({major: 2, version: '2.2.2', buildConfig, historyDir, git}))
      .rejects.toThrow('already tagged');
    await expect(generateReleaseRefs({major: 2, version: '3.0.1', buildConfig, historyDir, git}))
      .rejects.toThrow('does not follow');
  });
});
