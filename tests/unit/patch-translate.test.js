const {translatePatch} = require('../../src/patch-translate');

// A stand-in for what buildPackageMap reads out of a git ref, covering the three
// shapes that matter: a module, a nested package, and the parent that contains it.
const packageMap = new Map([
  ['magento/module-cms', 'app/code/Magento/Cms'],
  ['magento/module-media-gallery-ui-api', 'app/code/Magento/MediaGalleryUiApi'],
  ['magento/framework', 'lib/internal/Magento/Framework'],
  ['magento/framework-amqp', 'lib/internal/Magento/Framework/Amqp'],
  ['magento/theme-frontend-luma', 'app/design/frontend/Magento/luma'],
]);

const toSource = (patch) => translatePatch(patch, packageMap, 'to-source');
const toVendor = (patch) => translatePatch(patch, packageMap, 'to-vendor');

describe('translatePatch to-source', () => {
  it('rewrites git diff headers and file markers', () => {
    const patch = [
      'diff --git a/vendor/magento/module-cms/Model/Page.php b/vendor/magento/module-cms/Model/Page.php',
      'index 7acd00c..396b08a 100644',
      '--- a/vendor/magento/module-cms/Model/Page.php',
      '+++ b/vendor/magento/module-cms/Model/Page.php',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');

    const {text, stats} = toSource(patch);

    expect(text).toContain('diff --git a/app/code/Magento/Cms/Model/Page.php b/app/code/Magento/Cms/Model/Page.php');
    expect(text).toContain('--- a/app/code/Magento/Cms/Model/Page.php');
    expect(text).toContain('+++ b/app/code/Magento/Cms/Model/Page.php');
    expect(stats.translated).toBe(4);
    expect(stats.untranslated).toEqual([]);
  });

  it('handles markers without a/ b/ prefixes', () => {
    const patch = [
      '--- vendor/magento/module-cms/Model/Page.php',
      '+++ vendor/magento/module-cms/Model/Page.php',
    ].join('\n');

    expect(toSource(patch).text).toBe([
      '--- app/code/Magento/Cms/Model/Page.php',
      '+++ app/code/Magento/Cms/Model/Page.php',
    ].join('\n'));
  });

  it('preserves trailing timestamps on file markers', () => {
    const patch = '--- vendor/magento/module-cms/Model/Page.php\t2026-08-11 10:00:00.000000000 +0000';

    expect(toSource(patch).text)
      .toBe('--- app/code/Magento/Cms/Model/Page.php\t2026-08-11 10:00:00.000000000 +0000');
  });

  it('leaves /dev/null alone for added files', () => {
    const patch = [
      '--- /dev/null',
      '+++ b/vendor/magento/module-cms/Model/New.php',
    ].join('\n');

    const {text, stats} = toSource(patch);

    expect(text).toContain('--- /dev/null');
    expect(text).toContain('+++ b/app/code/Magento/Cms/Model/New.php');
    expect(stats.untranslated).toEqual([]);
  });

  it('prefers the deepest matching package', () => {
    const patch = '--- a/vendor/magento/framework-amqp/Config.php';

    expect(toSource(patch).text).toBe('--- a/lib/internal/Magento/Framework/Amqp/Config.php');
  });

  it('accepts mage-os vendor names for packages declared as magento in source', () => {
    const patch = '--- a/vendor/mage-os/module-cms/Model/Page.php';

    expect(toSource(patch).text).toBe('--- a/app/code/Magento/Cms/Model/Page.php');
  });

  it('rewrites rename headers', () => {
    const patch = [
      'rename from vendor/magento/module-cms/Model/Old.php',
      'rename to vendor/magento/module-cms/Model/New.php',
    ].join('\n');

    expect(toSource(patch).text).toBe([
      'rename from app/code/Magento/Cms/Model/Old.php',
      'rename to app/code/Magento/Cms/Model/New.php',
    ].join('\n'));
  });

  it('rewrites binary file markers', () => {
    const patch = 'Binary files a/vendor/magento/module-cms/logo.png and b/vendor/magento/module-cms/logo.png differ';

    expect(toSource(patch).text)
      .toBe('Binary files a/app/code/Magento/Cms/logo.png and b/app/code/Magento/Cms/logo.png differ');
  });

  it('reports unknown packages instead of mangling them', () => {
    const patch = '--- a/vendor/acme/module-unknown/Model/Thing.php';
    const {text, stats} = toSource(patch);

    expect(text).toBe(patch);
    expect(stats.translated).toBe(0);
    expect(stats.untranslated).toEqual(['vendor/acme/module-unknown/Model/Thing.php']);
  });

  it('leaves hunk bodies untouched even when they look like paths', () => {
    const patch = [
      '--- a/vendor/magento/module-cms/Model/Page.php',
      '+++ b/vendor/magento/module-cms/Model/Page.php',
      '@@ -1,2 +1,2 @@',
      "-require 'vendor/magento/module-cms/bootstrap.php';",
      "+require 'vendor/magento/module-cms/bootstrap2.php';",
    ].join('\n');

    const {text} = toSource(patch);

    expect(text).toContain("-require 'vendor/magento/module-cms/bootstrap.php';");
    expect(text).toContain("+require 'vendor/magento/module-cms/bootstrap2.php';");
  });
});

describe('translatePatch to-vendor', () => {
  it('inverts the source mapping', () => {
    const patch = '--- a/app/code/Magento/MediaGalleryUiApi/etc/acl.xml';

    expect(toVendor(patch).text).toBe('--- a/vendor/magento/module-media-gallery-ui-api/etc/acl.xml');
  });

  it('round-trips without loss', () => {
    const original = [
      'diff --git a/app/code/Magento/Cms/Model/Page.php b/app/code/Magento/Cms/Model/Page.php',
      '--- a/app/code/Magento/Cms/Model/Page.php',
      '+++ b/app/code/Magento/Cms/Model/Page.php',
      '--- a/lib/internal/Magento/Framework/Amqp/Config.php',
      '--- a/app/design/frontend/Magento/luma/web/css/source/_theme.less',
    ].join('\n');

    const vendored = toVendor(original).text;

    expect(vendored).not.toBe(original);
    expect(toSource(vendored).text).toBe(original);
  });
});

describe('translatePatch validation', () => {
  it('rejects an unknown direction', () => {
    expect(() => translatePatch('', packageMap, 'sideways')).toThrow(/Unknown direction/);
  });
});
