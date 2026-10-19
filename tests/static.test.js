/**
 * 项目静态契约检查：manifest、文件引用、官网结构与隐私约束。
 * 运行：node --test tests/static.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const exists = (relativePath) => fs.existsSync(path.join(ROOT, relativePath));
const manifest = JSON.parse(read('manifest.json'));

test('manifest 使用 MV3 并声明必要权限', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'background.js');
  for (const permission of ['activeTab', 'scripting', 'downloads', 'storage']) {
    assert.ok(manifest.permissions.includes(permission), `缺少权限：${permission}`);
  }
  assert.ok(Array.isArray(manifest.optional_host_permissions));
  assert.ok(manifest.minimum_chrome_version >= '109');
});

test('内容脚本覆盖淘宝、天猫、京东和拼多多域名', () => {
  const requiredMatches = [
    '*://*.taobao.com/*',
    '*://*.tmall.com/*',
    '*://*.jd.com/*',
    '*://*.pinduoduo.com/*',
    '*://*.yangkeduo.com/*'
  ];
  assert.equal(manifest.content_scripts.length, 1);
  const contentScript = manifest.content_scripts[0];
  for (const match of requiredMatches) {
    assert.ok(contentScript.matches.includes(match), `缺少匹配域名：${match}`);
    assert.ok(manifest.host_permissions.includes(match), `缺少 host_permissions：${match}`);
  }
  assert.deepEqual(contentScript.js, ['lib/image-core.js', 'content.js']);
  assert.deepEqual(contentScript.css, ['content.css']);
});

test('图片 CDN 与后台依赖文件均存在', () => {
  for (const host of [
    '*://*.alicdn.com/*',
    '*://*.360buyimg.com/*',
    '*://*.jdimg.com/*',
    '*://*.pddpic.com/*'
  ]) {
    assert.ok(manifest.host_permissions.includes(host), `缺少图片 CDN 权限：${host}`);
  }

  const requiredFiles = [
    'manifest.json',
    'background.js',
    'content.js',
    'content.css',
    'gallery.html',
    'gallery.js',
    'gallery.css',
    'lib/image-core.js',
    'lib/session-store.js',
    'lib/downloader.js',
    'assets/icon16.png',
    'assets/icon32.png',
    'assets/icon48.png',
    'assets/icon128.png'
  ];
  for (const file of requiredFiles) assert.ok(exists(file), `缺少文件：${file}`);

  const background = read('background.js');
  for (const dependency of ['lib/image-core.js', 'lib/session-store.js', 'lib/downloader.js']) {
    assert.match(background, new RegExp(dependency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('所有 JavaScript 文件语法有效', () => {
  const scripts = [
    'background.js',
    'content.js',
    'gallery.js',
    'lib/image-core.js',
    'lib/session-store.js',
    'lib/downloader.js',
    'docs/js/main.js'
  ];
  for (const file of scripts) {
    assert.doesNotThrow(() => new vm.Script(read(file), { filename: file }), `语法错误：${file}`);
  }
});

test('画廊页面具备选择、下载与进度反馈所需的界面骨架', () => {
  const html = read('gallery.html');
  const requiredIds = [
    'galleryWorkspace',
    'toolbar',
    'selectAllButton',
    'invertSelectionButton',
    'selectedCount',
    'downloadButton',
    'imageGrid',
    'downloadDialog',
    'downloadProgressbar',
    'successCount',
    'failureCount',
    'closeDownloadButton',
    'previewDialog'
  ];
  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少画廊元素 #${id}`);
  }
  for (const copy of ['全选', '反选', '下载选中', '图片预览', '打开下载文件夹']) {
    assert.ok(html.includes(copy), `画廊缺少文案：${copy}`);
  }
  assert.match(html, /<script src="lib\/image-core\.js"><\/script>/);
  assert.match(html, /<script src="gallery\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="gallery\.css">/);
});

test('官网包含产品介绍、核心功能、安装步骤与下载入口', () => {
  const html = read('docs/index.html');
  for (const id of ['top', 'about', 'features', 'install', 'download', 'siteHeader', 'siteNav']) {
    assert.match(html, new RegExp(`id="${id}"`), `官网缺少区块 #${id}`);
  }
  for (const copy of [
    '产品介绍',
    '核心功能',
    '安装步骤',
    '一键提取',
    '智能过滤',
    '集中预览',
    '自由勾选',
    '统一 PNG',
    '批量下载',
    'chrome://extensions',
    '加载已解压的扩展程序'
  ]) {
    assert.ok(html.includes(copy), `官网缺少内容：${copy}`);
  }
  assert.equal((html.match(/class="feature-card/g) || []).length, 6);
  assert.equal((html.match(/class="step reveal/g) || []).length, 4);
  assert.ok(exists('docs/css/style.css'));
  assert.ok(exists('docs/js/main.js'));
  assert.ok(exists('docs/assets/favicon.svg'));
  assert.ok(exists('docs/downloads/imagegrab-v1.0.0.zip'));
});

test('官网不依赖 CDN、外部图片或构建工具', () => {
  const html = read('docs/index.html');
  const css = read('docs/css/style.css');
  const main = read('docs/js/main.js');

  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)="https?:\/\//i);
  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(css, /@import\s+url|url\(\s*["']?https?:\/\//i);
  assert.doesNotMatch(css, /@font-face/i);
  assert.match(css, /--primary:/);
  assert.match(css, /@media\s*\(max-width:\s*320px|@media\s*\(max-width:\s*340px|min-width:\s*320px/);
  assert.match(main, /IntersectionObserver/);
  assert.match(main, /aria-expanded/);
});

test('下载转换实现明确输出 PNG 并等待落盘完成', () => {
  const downloader = read('lib/downloader.js');
  const background = read('background.js');
  assert.match(downloader, /convertToBlob\(\s*\{\s*type:\s*'image\/png'\s*\}\s*\)/);
  assert.match(downloader, /data:image\/png;base64/);
  assert.match(downloader, /chrome\.downloads\.download/);
  assert.match(downloader, /conflictAction:\s*'uniquify'/);
  assert.match(background, /buildImageFileName\(index \+ 1, '商品图'\)/);
  assert.match(background, /type: 'PROGRESS'/);
  assert.match(background, /type: 'DONE'/);
});

test('README 与官网发布包存在', () => {
  assert.ok(exists('README.md'));
  assert.ok(exists('docs/downloads/imagegrab-v1.0.0.zip'));
  const readme = read('README.md');
  for (const phrase of ['安装', '使用', '测试', 'chrome://extensions', 'PNG']) {
    assert.ok(readme.includes(phrase), `README 缺少：${phrase}`);
  }
});
