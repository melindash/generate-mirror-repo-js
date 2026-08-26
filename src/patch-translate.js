/**
 * Translates patch file paths between the Magento source tree layout
 * (app/code/Magento/Cms) and the installed Composer layout
 * (vendor/magento/module-cms).
 *
 * Adobe ships isolated security patches against an installed tree, so applying
 * one to this repository means rewriting every path in it. The two trees hold
 * byte-identical files, so the rewrite is total: no content is interpreted.
 */

const {execFileSync} = require('child_process');
const packagesConfig = require('./build-config/packages-config');

/**
 * Directories whose immediate subdirectories are each their own package, as
 * opposed to packageIndividual entries which are a single package apiece.
 */
const packageDirsFor = (definition) => (definition.packageDirs || []).map(entry => entry.dir);

const individualDirsFor = (definition) => (definition.packageIndividual || [])
  .map(entry => entry.dir)
  // dir '' is the base package, which is every path not claimed by another
  // entry; it has no directory of its own to map.
  .filter(dir => typeof dir === 'string' && dir !== '');

const readComposerName = (git, dir) => {
  const raw = git(['show', `${git.ref}:${dir}/composer.json`], {allowFailure: true});
  if (!raw) return null;
  try {
    const name = JSON.parse(raw).name;
    return typeof name === 'string' && name.includes('/') ? name : null;
  } catch (exception) {
    return null;
  }
};

const gitFor = (repoDir, ref) => {
  const git = (args, {allowFailure = false} = {}) => {
    try {
      return execFileSync('git', ['-C', repoDir, ...args], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 256,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (exception) {
      if (allowFailure) return null;
      throw exception;
    }
  };
  git.ref = ref;
  return git;
};

/**
 * Builds the package-name <-> source-directory mapping by reading each
 * package's own composer.json out of the given ref. The names are never
 * derived from the directory name: module directory CamelCase does not map to
 * package kebab-case by any rule the build itself relies on.
 */
const buildPackageMap = ({repoDir, ref, definitionKey = 'magento2'}) => {
  const definition = packagesConfig[definitionKey];
  if (!definition) {
    throw new Error(`No package definition "${definitionKey}" in packages-config`);
  }

  const git = gitFor(repoDir, ref);
  const toSource = new Map();

  for (const dir of packageDirsFor(definition)) {
    const listing = git(['ls-tree', '--name-only', `${ref}:${dir}`], {allowFailure: true});
    if (!listing) continue;
    for (const entry of listing.split('\n').filter(Boolean)) {
      const packageDir = `${dir}/${entry.replace(/\/$/, '')}`;
      const name = readComposerName(git, packageDir);
      if (name) toSource.set(name, packageDir);
    }
  }

  for (const dir of individualDirsFor(definition)) {
    const name = readComposerName(git, dir);
    if (name) toSource.set(name, dir);
  }

  return toSource;
};

/**
 * Longest-first so that lib/internal/Magento/Framework/Amqp is matched before
 * the lib/internal/Magento/Framework that contains it.
 */
const sortedByDepth = (map) => [...map.entries()].sort((a, b) => b[1].length - a[1].length);

const makeTranslators = (packageMap) => {
  const byDepth = sortedByDepth(packageMap);

  const sourceToVendor = (path) => {
    for (const [name, dir] of byDepth) {
      if (path === dir) return `vendor/${name}`;
      if (path.startsWith(`${dir}/`)) return `vendor/${name}${path.slice(dir.length)}`;
    }
    return null;
  };

  const vendorToSource = (path) => {
    const match = path.match(/^vendor\/([^/]+\/[^/]+)(\/.*)?$/);
    if (!match) return null;
    const [, name, rest] = match;
    // The source tree declares magento/*; the published packages are renamed to
    // mage-os/* at build time, so an incoming patch may use either vendor.
    const candidates = [name, name.replace(/^mage-os\//, 'magento/')];
    for (const candidate of candidates) {
      const dir = packageMap.get(candidate);
      if (dir) return `${dir}${rest || ''}`;
    }
    return null;
  };

  return {sourceToVendor, vendorToSource};
};

// Matches the path-bearing lines of a unified diff. Trailing text after the
// path (timestamps, tabs) is preserved verbatim.
const DIFF_GIT = /^(diff --git )(\S+)( )(\S+)(.*)$/;
const FILE_MARKER = /^(---|\+\+\+)(\s+)(\S+)(.*)$/;
const RENAME = /^(rename (?:from|to) )(.+)$/;
const BINARY = /^(Binary files )(\S+)( and )(\S+)( differ)$/;

/**
 * Strips a leading a/ or b/ so the path can be looked up, and restores it after.
 * Real-world patches appear both with and without the prefix.
 */
const withPrefix = (path, translate) => {
  const match = path.match(/^([ab]\/)(.*)$/);
  const prefix = match ? match[1] : '';
  const bare = match ? match[2] : path;
  if (bare === '/dev/null' || path === '/dev/null') return null;
  const translated = translate(bare);
  return translated === null ? null : prefix + translated;
};

const translatePatch = (patchText, packageMap, direction) => {
  const {sourceToVendor, vendorToSource} = makeTranslators(packageMap);
  const translate = direction === 'to-vendor' ? sourceToVendor : vendorToSource;
  if (direction !== 'to-vendor' && direction !== 'to-source') {
    throw new Error(`Unknown direction "${direction}", expected to-vendor or to-source`);
  }

  const stats = {translated: 0, untranslated: []};

  const rewrite = (path) => {
    if (path === '/dev/null') return path;
    const out = withPrefix(path, translate);
    if (out === null) {
      stats.untranslated.push(path.replace(/^[ab]\//, ''));
      return path;
    }
    stats.translated++;
    return out;
  };

  const text = patchText.split('\n').map(line => {
    let match = line.match(DIFF_GIT);
    if (match) {
      return match[1] + rewrite(match[2]) + match[3] + rewrite(match[4]) + match[5];
    }
    match = line.match(BINARY);
    if (match) {
      return match[1] + rewrite(match[2]) + match[3] + rewrite(match[4]) + match[5];
    }
    match = line.match(FILE_MARKER);
    if (match) {
      return match[1] + match[2] + rewrite(match[3]) + match[4];
    }
    match = line.match(RENAME);
    if (match) {
      return match[1] + rewrite(match[2]);
    }
    return line;
  }).join('\n');

  stats.untranslated = [...new Set(stats.untranslated)];
  return {text, stats};
};

module.exports = {buildPackageMap, translatePatch};
