const fs = require('fs');
const path = require('path');
const parseOptions = require('parse-options');

/**
 * The make scripts declare their options twice: once in the parse-options spec
 * and once in the --help text. When the two drift, parse-options throws an
 * opaque TypeError on the documented-but-undeclared flag rather than ignoring
 * it, so the failure surfaces as a crash mid-release-build.
 */

const makeDir = path.join(__dirname, '../../src/make');
const scripts = fs.readdirSync(makeDir).filter(name => name.endsWith('.js'));

const specOf = (source) => {
  const match = source.match(/parseOptions\(\s*`([^`]+)`/);
  return match ? match[1] : null;
};

const documentedOptionsOf = (source) => {
  const help = source.match(/console\.log\(`([\s\S]*?)`\)/);
  if (!help) return [];
  return [...help[1].matchAll(/^\s{2}--([A-Za-z][A-Za-z0-9]*)[= ]/gm)].map(m => m[1]);
};

describe.each(scripts)('%s option spec', (script) => {
  const source = fs.readFileSync(path.join(makeDir, script), 'utf8');
  const spec = specOf(source);
  const documented = documentedOptionsOf(source);

  it('declares every option its help text documents', () => {
    if (!spec || documented.length === 0) return;

    const declared = new Set(
      spec.split(/\s+/)
        .filter(Boolean)
        .map(token => token.replace(/^[$@]/, '').split('|')[0])
    );

    expect(documented.filter(option => !declared.has(option))).toEqual([]);
  });

  it('accepts every documented option without throwing', () => {
    if (!spec || documented.length === 0) return;

    for (const option of documented) {
      expect(() => parseOptions(spec, ['node', script, `--${option}=x`])).not.toThrow();
    }
  });
});
