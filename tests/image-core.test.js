/**
 * 共享纯函数的单元测试。
 * 运行：node --test tests/image-core.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../lib/image-core.js');

test('hostMatches 仅匹配域名本身和子域名', () => {
  assert.equal(Core.hostMatches('item.taobao.com', ['taobao.com']), true);
  assert.equal(Core.hostMatches('taobao.com', ['taobao.com']), true);
  assert.equal(Core.hostMatches('faketaobao.com', ['taobao.com']), false);
  assert.equal(Core.hostMatches('item.taobao.com.evil.test', ['taobao.com']), false);
});

test('isProductDetailUrl 覆盖淘宝/天猫详情页并排除首页和搜索页', () => {
  assert.equal(Core.isProductDetailUrl('https://item.taobao.com/item.htm?spm=a1&id=1234567890'), true);
  assert.equal(Core.isProductDetailUrl('https://detail.tmall.com/item.htm?id=9876543210'), true);
  assert.equal(Core.isProductDetailUrl('https://world.taobao.com/item/123456789.htm'), true);
  assert.equal(Core.isProductDetailUrl('https://www.taobao.com/'), false);
  assert.equal(Core.isProductDetailUrl('https://s.taobao.com/search?q=bag&id=123456789'), false);
  assert.equal(Core.isProductDetailUrl('https://login.taobao.com/member/login.jhtml?redirect=x&id=123456789'), false);
  assert.equal(Core.isProductDetailUrl('https://item.taobao.com/item.htm'), false);
});

test('isProductDetailUrl 覆盖京东 PC/移动端和拼多多商家版路由', () => {
  assert.equal(Core.isProductDetailUrl('https://item.jd.com/100012043978.html'), true);
  assert.equal(Core.isProductDetailUrl('https://item.jd.com/12345.html'), true);
  assert.equal(Core.isProductDetailUrl('https://item.m.jd.com/product/100012043978.html'), true);
  assert.equal(Core.isProductDetailUrl('https://search.jd.com/Search?keyword=bag'), false);
  assert.equal(Core.isProductDetailUrl('https://cart.jd.com/cart.action'), false);

  assert.equal(Core.isProductDetailUrl('https://mobile.yangkeduo.com/goods.html?goods_id=123456789'), true);
  assert.equal(Core.isProductDetailUrl('https://mobile.pinduoduo.com/goods2.html?goods_id=123456789'), true);
  assert.equal(Core.isProductDetailUrl('https://mms.pinduoduo.com/goods/goods_detail?goods_id=123456789'), true);
  assert.equal(Core.isProductDetailUrl('https://mms.pinduoduo.com/goods/list'), false);
  assert.equal(Core.isProductDetailUrl('https://example.com/item.htm?id=123456789'), false);
});

test('normalizeImageUrl 处理协议相对、相对路径和 CSS url()', () => {
  const base = 'https://item.taobao.com/item.htm?id=123456789';
  assert.equal(
    Core.normalizeImageUrl('//img.alicdn.com/a.jpg?x=1#fragment', base),
    'https://img.alicdn.com/a.jpg?x=1'
  );
  assert.equal(
    Core.normalizeImageUrl('/assets/photo%201.png', base),
    'https://item.taobao.com/assets/photo%201.png'
  );
  assert.equal(
    Core.normalizeImageUrl(`url("/assets/a.png?x=1&amp;y=2")`, base),
    'https://item.taobao.com/assets/a.png?x=1&y=2'
  );
  assert.equal(Core.normalizeImageUrl('javascript:alert(1)', base), null);
  assert.equal(Core.normalizeImageUrl('data:image/png;base64,AA==', base), null);
  assert.equal(Core.normalizeImageUrl('blob:https://item.taobao.com/uuid', base), null);
  assert.equal(Core.normalizeImageUrl('', base), null);
});

test('extractBackgroundUrls 支持单双引号与多个背景', () => {
  const value = `url("https://a.test/1.png"), linear-gradient(#fff, #000), url('https://a.test/2.jpg')`;
  assert.deepEqual(Core.extractBackgroundUrls(value), [
    'https://a.test/1.png',
    'https://a.test/2.jpg'
  ]);
  assert.deepEqual(Core.extractBackgroundUrls('none'), []);
});

test('parseSrcset 解析不同描述符并优先最高分辨率', () => {
  const base = 'https://item.taobao.com/item.htm?id=123456789';
  const parsed = Core.parseSrcset('/img-1x.jpg 1x, /img-2x.jpg 2x, /img-3x.jpg 3x', base);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].url, 'https://item.taobao.com/img-3x.jpg');
  assert.equal(Core.pickBestFromSrcset('/w400.jpg 400w, /w1200.jpg 1200w', base), 'https://item.taobao.com/w1200.jpg');
  assert.equal(Core.pickBestFromSrcset('', base), null);
});

test('isDecorativeImageUrl 过滤图标、logo、占位图与小尺寸 CDN 图', () => {
  assert.equal(Core.isDecorativeImageUrl('https://img.alicdn.com/logo/brand.png'), true);
  assert.equal(Core.isDecorativeImageUrl('https://img.alicdn.com/icon/arrow.png'), true);
  assert.equal(Core.isDecorativeImageUrl('https://img.alicdn.com/a/placeholder.jpg'), true);
  assert.equal(Core.isDecorativeImageUrl('https://img.alicdn.com/a/blank.gif'), true);
  assert.equal(Core.isDecorativeImageUrl('https://img.alicdn.com/a/photo_60x60.jpg'), true);
  assert.equal(Core.isDecorativeImageUrl('https://img.alicdn.com/a/photo.jpg?w=80&h=80'), true);
  assert.equal(Core.isDecorativeImageUrl('https://img.alicdn.com/a/t.png'), true);
  assert.equal(Core.isDecorativeImageUrl('https://img.alicdn.com/a/vector.svg'), true);
  assert.equal(Core.isDecorativeImageUrl('https://img.alicdn.com/a/photo.jpg'), false);
  assert.equal(Core.isDecorativeImageUrl('https://img.alicdn.com/a/photo_1200x90.jpg'), false);
  assert.equal(Core.isDecorativeImageUrl('https://img.alicdn.com/a/photo.webp?width=900&height=900'), false);
});

test('isBelowMinImageSize 仅在宽高都小于阈值时返回 true', () => {
  assert.equal(Core.isBelowMinImageSize(99, 99, 100), true);
  assert.equal(Core.isBelowMinImageSize(100, 99, 100), false);
  assert.equal(Core.isBelowMinImageSize(99, 500, 100), false);
  assert.equal(Core.isBelowMinImageSize(0, 0, 100), false);
  assert.equal(Core.isBelowMinImageSize(640, 420), false);
});

test('buildImageFileName 输出商品图_001.png 并自动补零', () => {
  assert.equal(Core.buildImageFileName(1), '商品图_001.png');
  assert.equal(Core.buildImageFileName(9), '商品图_009.png');
  assert.equal(Core.buildImageFileName(42), '商品图_042.png');
  assert.equal(Core.buildImageFileName(999), '商品图_999.png');
  assert.equal(Core.buildImageFileName(1000), '商品图_1000.png');
  assert.equal(Core.buildImageFileName(2, '商品图'), '商品图_002.png');
});

test('格式化函数输出可读的尺寸、文件大小与耗时', () => {
  assert.equal(Core.formatDimensions(640, 420), '640 × 420');
  assert.equal(Core.formatDimensions(0, 0), '尺寸待识别');
  assert.equal(Core.formatFileSize(512), '512 B');
  assert.equal(Core.formatFileSize(2048), '2.0 KB');
  assert.equal(Core.formatFileSize(2 * 1024 * 1024), '2.0 MB');
  assert.equal(Core.formatDuration(41000), '41 秒');
  assert.equal(Core.formatDuration(125000), '2 分 5 秒');
});

test('getUncoveredImageOrigins 只为未知图片源生成去重后的权限模式', () => {
  const origins = Core.getUncoveredImageOrigins([
    'https://img.alicdn.com/a.jpg',
    'https://img10.360buyimg.com/b.jpg',
    'https://cdn.example.com/a.jpg',
    'https://cdn.example.com/b.jpg',
    'https://img.pddpic.com/c.png',
    'data:image/png;base64,AA=='
  ]);
  assert.deepEqual(origins, ['https://cdn.example.com/*']);
  assert.equal(Core.toOriginPattern('https://cdn.example.com/a.jpg?x=1'), 'https://cdn.example.com/*');
  assert.equal(Core.toOriginPattern('data:image/png;base64,AA=='), null);
});

test('extractProductId 可从常见路由读取商品 ID', () => {
  assert.equal(Core.extractProductId('https://item.taobao.com/item.htm?id=1234567890'), '1234567890');
  assert.equal(Core.extractProductId('https://item.jd.com/100012043978.html'), '100012043978');
  assert.equal(Core.extractProductId('https://mobile.yangkeduo.com/goods.html?goods_id=987654321'), '987654321');
  assert.equal(Core.extractProductId('https://www.taobao.com/'), '');
});
