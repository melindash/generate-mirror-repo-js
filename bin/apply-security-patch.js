/**
 * Run with
 *
 * node bin/apply-security-patch.js --repoDir=/path/to/mageos-magento2 \
 *   --patch=249-2026-08-001-CE.patch --branches=main,release/3.x --label=apsb26-92
 *
 * Translates an Adobe isolated security patch to source tree paths and applies
 * it to each supported line, leaving one local branch per line for review.
 *
 * The patch itself is never written into the repository. Adobe's patch files are
 * proprietary; the resulting change to Mage-OS's own source is not. Only the
 * latter is committed.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {execFileSync} = require('child_process');
const parseOptions = require('parse-options');
const {buildPackageMap, translatePatch} = require('../src/patch-translate');

const options = parseOptions(
  `$repoDir $patch $branches $label $direction @help|h`,
  process.argv
);

if (options.help || !options.repoDir || !options.patch || !options.branches) {
  console.log(`Apply an Adobe isolated security patch across Mage-OS release lines.

Usage:
  node bin/apply-security-patch.js [OPTIONS]

Options:
  --repoDir=   Path to a mageos-magento2 checkout (required)
  --patch=     Adobe patch file, or - for STDIN (required)
  --branches=  Comma separated target branches (required), e.g. main,release/3.x
  --label=     Short name used for the created branches (default: security-patch)
  --direction= to-source (default) or none, to skip translation

Creates and commits one branch per target, named <label>-<branch>, and returns
the repository to the ref it started on. Conflicts are left in the working tree
for resolution and reported in the summary.
`);
  process.exit(1);
}

const repoDir = options.repoDir;
const label = options.label || 'security-patch';
const targets = options.branches.split(',').map(s => s.trim()).filter(Boolean);

const git = (args, {cwd = repoDir, allowFailure = false} = {}) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 256,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (exception) {
    if (allowFailure) return null;
    throw exception;
  }
};

const patchText = options.patch === '-'
  ? fs.readFileSync(0, 'utf8')
  : fs.readFileSync(options.patch, 'utf8');

const branchName = (target) => `${label}-${target.replace(/[^A-Za-z0-9._-]/g, '-')}`;

const results = [];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mageos-patch-'));

// Restored at the end: the tool checks out a branch per target, and leaving the
// repository on the last one makes a second run fail to check anything out.
const startingRef = (git(['symbolic-ref', '--quiet', '--short', 'HEAD'], {allowFailure: true})
  || git(['rev-parse', 'HEAD'], {allowFailure: true}) || '').trim();

for (const target of targets) {
  // The mapping is rebuilt per branch: a module can be added or renamed between
  // lines, so a map built from one branch may not describe another.
  let translated;
  try {
    const packageMap = buildPackageMap({repoDir, ref: target});
    if (packageMap.size === 0) throw new Error(`no packages found at ${target}`);

    if (options.direction === 'none') {
      translated = {text: patchText, stats: {translated: 0, untranslated: []}};
    } else {
      translated = translatePatch(patchText, packageMap, 'to-source');
      if (translated.stats.untranslated.length) {
        results.push({
          target,
          status: 'UNMAPPED',
          detail: translated.stats.untranslated.join(' '),
        });
        continue;
      }
    }
  } catch (exception) {
    results.push({target, status: 'ERROR', detail: exception.message});
    continue;
  }

  const patchFile = path.join(scratch, `${branchName(target)}.patch`);
  fs.writeFileSync(patchFile, translated.text);

  const branch = branchName(target);
  git(['branch', '-D', branch], {allowFailure: true});
  if (git(['checkout', '-b', branch, target], {allowFailure: true}) === null) {
    results.push({target, status: 'ERROR', detail: `cannot check out ${target}`});
    continue;
  }

  // git apply is atomic: one rejected file rolls the whole patch back. Without
  // the stderr the result is an unexplained "nothing applied", when in practice
  // it usually means a single hunk is already present upstream.
  let applyOutput = '';
  try {
    execFileSync('git', ['-C', repoDir, 'apply', '--3way', patchFile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (exception) {
    applyOutput = `${exception.stdout || ''}${exception.stderr || ''}`;
  }

  const blockedFiles = [...new Set(
    [...applyOutput.matchAll(/error: patch failed: ([^:\n]+):/g)].map(match => match[1])
  )];

  // A file can fail to apply because the fix is already present by another
  // route, which looks identical to a real conflict in git's output. Comparing
  // the patch's added lines against the file on disk distinguishes the two well
  // enough to tell a reviewer where to look. It is a signal, not a proof.
  const alreadyPresent = (file) => {
    const target = path.join(repoDir, file);
    if (!fs.existsSync(target)) return null;
    const contents = fs.readFileSync(target, 'utf8');
    const added = translated.text.split('\n')
      .filter(line => line.startsWith('+') && !line.startsWith('+++'))
      .map(line => line.slice(1).trim())
      .filter(line => line.length > 12);
    if (added.length === 0) return null;
    const found = added.filter(line => contents.includes(line)).length;
    return Math.round((found / added.length) * 100);
  };

  const status = git(['status', '--porcelain'], {allowFailure: true}) || '';
  const conflicts = status.split('\n')
    .filter(line => /^(UU|AA|DD|AU|UA|DU|UD) /.test(line))
    .map(line => line.slice(3));
  const applied = status.split('\n').filter(line => /^[MA][ M] /.test(line)).length;

  if (applied === 0 && conflicts.length === 0) {
    results.push({
      target,
      status: blockedFiles.length ? 'REJECTED' : 'NO-OP',
      detail: blockedFiles.length
        ? `rolled back, blocked by: ${blockedFiles.map(file => {
            const pct = alreadyPresent(file);
            return pct === null ? file : `${file} (${pct}% of added lines already present)`;
          }).join(' ')}`
        : 'patch produced no changes',
    });
    continue;
  }

  if (conflicts.length) {
    results.push({
      target,
      status: 'CONFLICT',
      detail: `${applied} applied, ${conflicts.length} conflicted: ${conflicts.join(' ')}`,
      branch,
    });
    continue;
  }

  // Always committed: the branch exists only to hold this result, and leaving it
  // staged means the tool cannot leave the branch, so a second target or a
  // second run cannot check anything out.
  git(['commit', '-m', `Port Adobe security patch ${label}`], {allowFailure: true});

  results.push({target, status: 'CLEAN', detail: `${applied} files applied`, branch});
}

fs.rmSync(scratch, {recursive: true, force: true});

if (startingRef) {
  // Staged results live on their own branches, so returning to the starting ref
  // does not discard anything.
  git(['checkout', startingRef], {allowFailure: true});
}

const widthOf = (key, heading) =>
  Math.max(heading.length, ...results.map(r => String(r[key] || '-').length)) + 2;

const columns = [
  ['target', 'TARGET'],
  ['status', 'STATUS'],
  ['branch', 'BRANCH'],
  ['detail', 'DETAIL'],
];

console.log('');
console.log(columns.map(([key, heading], i) =>
  i === columns.length - 1 ? heading : heading.padEnd(widthOf(key, heading))
).join(''));
console.log('-'.repeat(
  columns.slice(0, -1).reduce((sum, [key, heading]) => sum + widthOf(key, heading), 0) + 40
));
for (const result of results) {
  console.log(columns.map(([key, heading], i) => {
    const value = String(result[key] || (key === 'branch' ? '-' : ''));
    return i === columns.length - 1 ? value : value.padEnd(widthOf(key, heading));
  }).join(''));
}
console.log('');

const failed = results.filter(r => r.status === 'ERROR' || r.status === 'UNMAPPED');
const conflicted = results.filter(r => r.status === 'CONFLICT');
if (conflicted.length) {
  console.log(`${conflicted.length} branch(es) need conflict resolution before review.`);
}
process.exit(failed.length ? 1 : 0);
