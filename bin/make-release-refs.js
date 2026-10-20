#!/usr/bin/env node
/**
 * Writes the release refs file for the next patch release of an older major.
 *
 *   node bin/make-release-refs.js --line=2 [--version=2.3.1] [--dryRun]
 */

const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const parseOptions = require('parse-options');
const {buildConfig} = require('../src/build-config/mageos-release-build-config');
const {generateReleaseRefs} = require('../src/release-refs-generator');

const options = parseOptions(`$line $version $vendor @dryRun @help|h`, process.argv);

if (options.help || !options.line) {
  console.log(`Write the release refs file for the next patch release of an older major.

Usage:
  node bin/make-release-refs.js --line=<major> [OPTIONS]

Options:
  --line=     Major to release, e.g. 2
  --version=  Release version (default: the line's last tag, patch + 1)
  --vendor=   Composer vendor of the release (default: mage-os)
  --dryRun    Print the file instead of writing it

Every repository is built from the line's last tag. A repository is built from
release/<major>.x instead when that branch has commits past the tag's source commit.
Set GITHUB_TOKEN to avoid the anonymous API rate limit.
`);
  process.exit(options.help ? 0 : 1);
}

const vendor = options.vendor || 'mage-os';
const root = path.join(__dirname, '..');

const lsRemote = (...args) => execFileSync('git', ['ls-remote', ...args], {encoding: 'utf8'})
  .split('\n').filter(Boolean).map(line => line.split('\t')[1]);

const githubRepo = url => {
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!match) throw new Error(`${url} is not a GitHub repository`);
  return match[1];
};

const api = async route => {
  const response = await fetch(`https://api.github.com/repos/${route}`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(process.env.GITHUB_TOKEN ? {authorization: `Bearer ${process.env.GITHUB_TOKEN}`} : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub ${route}: HTTP ${response.status}`);
  return response.json();
};

const git = {
  listTags: async url => lsRemote('--tags', '--refs', url).map(ref => ref.replace('refs/tags/', '')),
  hasBranch: async (url, branch) => lsRemote('--heads', url, branch).includes(`refs/heads/${branch}`),
  commitsAhead: async (url, tag, branch) => {
    const repo = githubRepo(url);
    const tagCommit = await api(`${repo}/commits/${encodeURIComponent(tag)}`);
    const source = tagCommit.parents[0] && tagCommit.parents[0].sha;
    if (!source) throw new Error(`${repo}: tag ${tag} has no parent commit`);
    const comparison = await api(`${repo}/compare/${source}...${encodeURIComponent(branch)}`);
    if (!['ahead', 'identical'].includes(comparison.status)) {
      throw new Error(`${repo}: ${branch} does not contain ${source.slice(0, 11)}, the source commit of ${tag}; cut it from there`);
    }
    return comparison.ahead_by;
  },
};

(async () => {
  const result = await generateReleaseRefs({
    major: options.line,
    version: options.version,
    buildConfig,
    git,
    historyDir: path.join(root, 'resource', 'history', vendor, 'product-community-edition'),
  });
  result.notes.forEach(note => console.error(note));

  if (options.dryRun) {
    process.stdout.write(result.content);
    return;
  }
  const file = path.join(root, 'src', 'build-config', `${vendor}-release-refs`, `${result.version}.js`);
  if (fs.existsSync(file)) throw new Error(`${path.relative(root, file)} already exists`);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, result.content);
  console.log(path.relative(root, file));
})().catch(exception => {
  console.error(exception.message);
  process.exit(1);
});
