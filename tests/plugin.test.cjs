'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

/** 从指定根目录解析包内引用，拒绝越界或缺失的路径。 */
function resolveReference(base, reference) {
  assert.equal(typeof reference, 'string');
  assert.ok(reference.startsWith('./'));
  const resolved = path.resolve(base, reference);
  assert.ok(resolved.startsWith(`${base}${path.sep}`));
  assert.ok(fs.existsSync(resolved), `引用文件不存在：${reference}`);
  return resolved;
}

test('marketplace 可以从仓库根目录定位唯一插件及完整技能', () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(root, '.agents/plugins/marketplace.json'), 'utf8'));
  assert.equal(marketplace.name, 'taobao-tools');
  assert.equal(marketplace.plugins.length, 1);
  const entry = marketplace.plugins[0];
  assert.equal(entry.source.source, 'local');
  assert.equal(entry.policy.installation, 'AVAILABLE');
  assert.equal(entry.policy.authentication, 'ON_INSTALL');
  assert.equal(entry.category, 'Productivity');
  const pluginRoot = resolveReference(root, entry.source.path);
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, entry.name);
  assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
  assert.equal(manifest.extensions['com.openai'].requires_local_executor, true);
  const skillRoot = resolveReference(pluginRoot, './skills/taobao-ide-console');
  for (const reference of ['./SKILL.md', './agents/openai.yaml', './scripts/read-console.cjs', './scripts/read-console.test.cjs']) {
    assert.ok(fs.statSync(resolveReference(skillRoot, reference)).isFile());
  }
});

test('插件图标引用有效，SVG 为至少 48 像素的正方形', () => {
  const pluginRoot = path.join(root, 'plugins/taobao-ide-console');
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8'));
  for (const key of ['composerIcon', 'logo']) {
    const asset = resolveReference(pluginRoot, manifest.extensions['com.openai'].interface[key]);
    const content = fs.readFileSync(asset, 'utf8');
    const dimensions = /viewBox="0 0 (\d+) (\d+)"/.exec(content);
    assert.ok(dimensions);
    assert.equal(dimensions[1], dimensions[2]);
    assert.ok(Number(dimensions[1]) >= 48);
    assert.ok(fs.statSync(asset).size <= 5 * 1024 * 1024);
  }
});
