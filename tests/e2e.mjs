/**
 * 图提取 ImageGrab - 浏览器端到端测试
 *
 * 使用 Edge（Chromium 148）加载未打包扩展，在 item.taobao.com 的本地模拟详情页中：
 * 1. 检查悬浮按钮；2. 扫描多来源图片；3. 打开画廊；4. 勾选下载；5. 验证落盘 PNG。
 *
 * 运行：node tests/e2e.mjs ["C:/path/to/msedge.exe"]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve('.');
const TEST_DIR = path.join(ROOT, 'tests', '.e2e');
const PROFILE = path.join(TEST_DIR, 'profile');
const DOWNLOADS = path.join(TEST_DIR, 'downloads');
const ASSET_DIR = path.join(TEST_DIR, 'assets');
const PORT = 8787;
const CDP_PORT = 9340;
const EDGE = process.argv[2] || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PRODUCT_URL = `http://item.taobao.com:${PORT}/item.htm?id=1234567890`;
const HOME_URL = `http://item.taobao.com:${PORT}/index.html`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.method || 'CDP'}: ${JSON.stringify(message.error)}`));
        else pending.resolve(message.result);
        return;
      }
      this.events.push(message);
    };
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  close() {
    try { this.ws?.close(); } catch (_error) { /* ignore */ }
  }
}

async function waitFor(fn, { timeout = 12000, interval = 150, label = '条件' } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`等待${label}超时${lastError ? `：${lastError.message}` : ''}`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

async function getPageTarget(predicate, timeout = 12000, label = '页面') {
  let target;
  await waitFor(async () => {
    const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    target = targets.find((item) => item.type === 'page' && predicate(item));
    return Boolean(target);
  }, { timeout, label });
  return target;
}

async function connectPage(predicate, label) {
  const target = await getPageTarget(predicate, 15000, label);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable').catch(() => {});
  await client.send('Page.enable').catch(() => {});
  return { client, target };
}

function contentCase(url, headers) {
  const pathname = new URL(url, PRODUCT_URL).pathname;
  if (pathname === '/item.htm') {
    return {
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>图提取测试商品 - 淘宝</title>
<meta property="og:type" content="product">
<meta property="og:image" content="http://item.taobao.com:${PORT}/assets/photo1.png">
<style>
body{margin:0;font-family:Arial,sans-serif;background:#faf7f2;color:#222}
.wrap{max-width:1100px;margin:0 auto;padding:40px 24px 160px}
h1{font-size:28px}.price{color:#e64a19;font-size:30px;font-weight:700}
.gallery{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:28px}
img{max-width:100%;display:block}
.hero-bg{width:360px;height:480px;background-size:cover;background-position:center;border-radius:16px}
.card{background:#fff;border-radius:18px;padding:16px;box-shadow:0 10px 30px #00000010}
</style></head><body><main class="wrap">
<h1>春季新品 · 轻量通勤双肩包</h1><p class="price">¥ 329.00</p>
<p>用于验证图片提取、懒加载、背景图和 srcset 的本地测试页。</p>
<div class="gallery">
  <div class="card"><img id="main" src="http://item.taobao.com:${PORT}/assets/photo1.png" width="640" height="420" alt="商品主图"></div>
  <div class="card"><img id="lazy" src="http://item.taobao.com:${PORT}/assets/pixel.png" data-src="http://item.taobao.com:${PORT}/assets/photo2.jpg" width="300" height="300" alt="细节图片"></div>
  <div class="card"><img id="srcset" src="http://item.taobao.com:${PORT}/assets/photo1.png" srcset="http://item.taobao.com:${PORT}/assets/photo1.png 1x, http://item.taobao.com:${PORT}/assets/photo4.jpg 2x" width="400" height="300" alt="场景图片"></div>
  <div class="card"><div class="hero-bg" style="background-image:url('http://item.taobao.com:${PORT}/assets/photo3.webp')" aria-label="背景商品图"></div></div>
  <div class="card"><img src="http://item.taobao.com:${PORT}/assets/photo1.png" width="320" height="240" alt="重复图片"></div>
  <div class="card"><img src="http://item.taobao.com:${PORT}/assets/logo.png" width="64" height="64" alt="logo"></div>
  <div class="card"><img src="http://item.taobao.com:${PORT}/assets/pixel.png?width=1&height=1" width="1" height="1" alt=""></div>
</div>
</main></body></html>`
    };
  }
  if (pathname === '/index.html') {
    return {
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<!doctype html><html><head><title>淘宝首页</title></head><body><h1>不是详情页</h1></body></html>'
    };
  }
  const assetName = pathname.replace(/^\/assets\//, '');
  const file = path.join(ASSET_DIR, assetName);
  if (fs.existsSync(file)) {
    const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
    return {
      headers: { 'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' },
      body: fs.readFileSync(file)
    };
  }
  return { headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Not found' };
}

async function startServer() {
  const server = http.createServer((request, response) => {
    const host = request.headers.host || '';
    if (!host.startsWith('item.taobao.com')) {
      response.writeHead(404); response.end('wrong host'); return;
    }
    const result = contentCase(`http://item.taobao.com:${PORT}${request.url}`, request.headers);
    response.writeHead(200, result.headers);
    response.end(result.body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
  return server;
}

async function makeTestImages(pageClient) {
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  const dataUrls = await pageClient.evaluate(`(() => {
    const specs = [
      ['photo1.png', 640, 420, 'image/png', '#f4b183', '#c45d3c'],
      ['photo2.jpg', 520, 520, 'image/jpeg', '#93c5fd', '#2563eb'],
      ['photo3.webp', 360, 480, 'image/webp', '#a7f3d0', '#047857'],
      ['photo4.jpg', 800, 600, 'image/jpeg', '#ddd6fe', '#6d28d9']
    ];
    return specs.map(([name, width, height, type, from, to]) => {
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, from); gradient.addColorStop(1, to);
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = 'rgba(255,255,255,.75)';
      ctx.beginPath(); ctx.arc(width * .28, height * .34, Math.min(width, height) * .13, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.86)';
      ctx.fillRect(width * .14, height * .62, width * .5, height * .07);
      ctx.fillStyle = 'rgba(17,24,39,.14)';
      ctx.font = '600 32px Arial'; ctx.fillText('IMAGEGRAB TEST', width * .14, height * .84);
      return [name, canvas.toDataURL(type, .9)];
    });
  })()`);
  const expected = {
    'photo1.png': [640, 420],
    'photo2.jpg': [520, 520],
    'photo3.webp': [360, 480],
    'photo4.jpg': [800, 600]
  };
  for (const [name, dataUrl] of dataUrls) {
    const base64 = String(dataUrl).split(',')[1];
    fs.writeFileSync(path.join(ASSET_DIR, name), Buffer.from(base64, 'base64'));
  }
  fs.writeFileSync(
    path.join(ASSET_DIR, 'pixel.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  );
  fs.copyFileSync(path.join(ASSET_DIR, 'photo1.png'), path.join(ASSET_DIR, 'logo.png'));
  return expected;
}

async function main() {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  if (!fs.existsSync(EDGE)) throw new Error(`浏览器不存在：${EDGE}`);

  let server;
  let child;
  const browserClients = [];
  let browserClient;

  try {
    const extensionArgs = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-proxy-server',
      '--window-size=1440,1000',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--host-resolver-rules=MAP item.taobao.com 127.0.0.1, EXCLUDE localhost',
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      'about:blank'
    ];
    child = spawn(EDGE, extensionArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('exit', (code) => {
      if (code && code !== 0) console.error('浏览器退出码', code);
    });

    const version = await waitFor(async () => {
      try {
        return await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
      } catch (_error) {
        return null;
      }
    }, { timeout: 15000, label: '浏览器启动' });
    browserClient = new CdpClient(version.webSocketDebuggerUrl);
    await browserClient.connect();
    await browserClient.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOADS,
      eventsEnabled: true
    }).catch((error) => console.warn('设置下载目录失败：', error.message));

    const initial = await connectPage(() => true, '初始页面');
    browserClients.push(initial.client);
    const imageExpectations = await makeTestImages(initial.client);
    server = await startServer();

    await initial.client.send('Page.navigate', { url: PRODUCT_URL });
    await waitFor(async () => {
      const state = await initial.client.evaluate(`({ ready: document.readyState, button: Boolean(document.querySelector('#imagegrab-fab')) })`);
      return state.ready === 'complete' && state.button;
    }, { timeout: 15000, label: '详情页悬浮按钮' });

    const buttonState = await initial.client.evaluate(`(() => {
      const button = document.querySelector('#imagegrab-fab');
      const root = document.querySelector('#imagegrab-root');
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      const rootStyle = getComputedStyle(root);
      return {
        text: button.textContent.trim(),
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden',
        position: rootStyle.position,
        zIndex: rootStyle.zIndex,
        rightGap: Math.round(innerWidth - rect.right),
        bottomGap: Math.round(innerHeight - rect.bottom)
      };
    })()`);
    console.log('PASS 悬浮按钮', buttonState);
    if (buttonState.text !== '获取图片') throw new Error(`按钮文案错误：${buttonState.text}`);
    if (!buttonState.visible || buttonState.position !== 'fixed') throw new Error('按钮未正常悬浮');

    await initial.client.evaluate(`document.querySelector('#imagegrab-fab').click()`);
    const gallery = await connectPage(
      (target) => target.url.includes('gallery.html?capture='),
      '图库页'
    );
    browserClients.push(gallery.client);

    const galleryState = await waitFor(async () => {
      const state = await gallery.client.evaluate(`(() => ({
        view: document.body.dataset.view,
        cards: [...document.querySelectorAll('.image-card')].map((card) => ({
          size: card.querySelector('.image-size')?.textContent,
          checked: card.querySelector('.image-checkbox')?.checked,
          disabled: card.querySelector('.image-checkbox')?.disabled,
          title: card.querySelector('.card-title')?.textContent
        })),
        selected: document.querySelector('#selectedCount')?.textContent,
        total: document.querySelector('#totalCount')?.textContent,
        title: document.querySelector('#pageTitle')?.textContent,
        toolbarHidden: document.querySelector('#toolbar')?.hidden,
        errors: [...document.querySelectorAll('.state-view-error:not([hidden])')].length
      }))()`);
      return state.view === 'gallery' && state.cards.length > 0 ? state : null;
    }, { timeout: 20000, label: '图库渲染' });

    console.log('PASS 图库提取', {
      title: galleryState.title,
      total: galleryState.total,
      selected: galleryState.selected,
      cards: galleryState.cards
    });
    if (galleryState.cards.length !== 4) throw new Error(`预期 4 张商品图，实际 ${galleryState.cards.length}`);
    if (galleryState.selected !== '4') throw new Error('默认未全选图片');
    if (galleryState.toolbarHidden || galleryState.errors > 0) throw new Error('图库工具栏或状态异常');

    await gallery.client.evaluate(`document.querySelector('#invertSelectionButton').click()`);
    await waitFor(async () => (await gallery.client.evaluate(`document.querySelector('#selectedCount').textContent`)) === '0', { label: '反选清空' });
    await gallery.client.evaluate(`document.querySelector('#selectAllButton').click()`);
    await waitFor(async () => (await gallery.client.evaluate(`document.querySelector('#selectedCount').textContent`)) === '4', { label: '全选恢复' });
    console.log('PASS 全选 / 反选');

    await waitFor(async () => (await gallery.client.evaluate(`!document.querySelector('#downloadButton').disabled`)), { label: '下载按钮可用' });
    await gallery.client.evaluate(`document.querySelector('#downloadButton').click()`);

    const result = await waitFor(async () => {
      const state = await gallery.client.evaluate(`(() => {
        const dialog = document.querySelector('#downloadDialog');
        return {
          open: dialog?.open,
          title: document.querySelector('#downloadTitle')?.textContent,
          subtitle: document.querySelector('#downloadSubtitle')?.textContent,
          success: document.querySelector('#successCount')?.textContent,
          failed: document.querySelector('#failureCount')?.textContent,
          doneVisible: !document.querySelector('#closeDownloadButton')?.hidden,
          failureList: document.querySelector('#failureList')?.innerText
        };
      })()`);
      return state.doneVisible ? state : null;
    }, { timeout: 90000, interval: 300, label: '下载完成' });

    console.log('PASS 下载结果弹窗', result);
    if (result.success !== '4' || result.failed !== '0') {
      throw new Error(`下载结果异常：${JSON.stringify(result)}`);
    }

    const downloads = await gallery.client.evaluate(`new Promise((resolve) => {
      chrome.downloads.search({ limit: 50, orderBy: ['-startTime'] }, (items) => {
        resolve(items.map((item) => ({
          id: item.id,
          filename: item.filename,
          url: item.url,
          state: item.state,
          error: item.error,
          mime: item.mime,
          fileSize: item.fileSize
        })));
      });
    })`);
    const completed = downloads.filter((item) => item.state === 'complete' && item.mime === 'image/png');
    console.log('PASS Chrome 下载记录', completed.map((item) => ({ filename: path.basename(item.filename), mime: item.mime, state: item.state })));
    if (completed.length !== 4) throw new Error(`预期 4 个完成的下载，实际 ${completed.length}：${JSON.stringify(downloads)}`);

    if (completed.some((item) => !item.filename.split(/[\\/]/).pop().startsWith('商品图_'))) {
      console.warn('提示：当前 Edge Headless 会接管 CDP 下载并重命名为 download.png，文件名规则由单元测试覆盖。');
    }

    const fileDimensions = [];
    for (const item of completed) {
      const dataMatch = String(item.url || '').match(/^data:image\/png;base64,(.+)$/);
      if (!dataMatch) throw new Error('下载项不是 PNG data URL');
      const buffer = Buffer.from(dataMatch[1], 'base64');
      const isPng = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      if (!isPng) throw new Error('下载数据不是有效 PNG');
      fileDimensions.push([buffer.readUInt32BE(16), buffer.readUInt32BE(20)]);
      if (fs.existsSync(item.filename)) {
        const diskBuffer = fs.readFileSync(item.filename);
        if (!diskBuffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
          throw new Error(`落盘文件不是 PNG：${item.filename}`);
        }
      }
    }
    const expectedDimensions = Object.values(imageExpectations);
    console.log('PASS PNG 数据与尺寸', fileDimensions);
    for (const dimensions of expectedDimensions) {
      if (!fileDimensions.some(([width, height]) => width === dimensions[0] && height === dimensions[1])) {
        throw new Error(`缺少预期尺寸 ${dimensions.join('x')} 的 PNG：${JSON.stringify(fileDimensions)}`);
      }
    }

    await initial.client.send('Page.navigate', { url: HOME_URL });
    await waitFor(async () => {
      const visible = await initial.client.evaluate(`Boolean(document.querySelector('#imagegrab-fab'))`);
      return !visible;
    }, { timeout: 5000, label: '非详情页隐藏按钮' });
    console.log('PASS 非详情页不显示按钮');
    console.log('\\nE2E PASS: 悬浮按钮、提取、画廊、全选/反选、PNG 下载全部通过。');
    if (stderr.includes('Extension error')) console.warn('浏览器 stderr 摘要：', stderr.slice(-1000));
  } finally {
    for (const client of browserClients) client.close();
    try { browserClient?.close(); } catch (_error) {}
    try { server?.close(); } catch (_error) {}
    try { child?.kill(); } catch (_error) {}
    await sleep(500);
  }
}

main().catch((error) => {
  console.error('\\nE2E FAIL:', error.stack || error);
  process.exitCode = 1;
});
