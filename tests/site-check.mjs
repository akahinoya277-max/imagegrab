import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve('.');
const OUT = path.join(ROOT, 'tests', '.site-check');
const PROFILE = path.join(OUT, 'profile');
const EDGE = process.argv[2] || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9350;
const PAGE_URL = pathToFileURL(path.join(ROOT, 'docs', 'index.html')).href;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text);
      }
      if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
        this.errors.push(message.params.entry.text);
      }
    };
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }

  close() {
    try { this.ws?.close(); } catch (_error) { /* ignore */ }
  }
}

async function waitFor(fn, timeout = 10000, label = '条件') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (_error) { /* retry */ }
    await sleep(120);
  }
  throw new Error(`等待${label}超时`);
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  if (!fs.existsSync(EDGE)) throw new Error(`浏览器不存在：${EDGE}`);

  const child = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-proxy-server',
    '--allow-file-access-from-files',
    '--window-size=1440,1200',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    PAGE_URL
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let client;
  try {
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      return targets.find((item) => item.type === 'page' && item.url.includes('docs/index.html'));
    }, 15000, '官网页面');

    client = new Cdp(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Runtime.enable');
    await client.send('Log.enable');
    await client.send('Page.enable');

    await waitFor(async () => client.evaluate(`document.readyState === 'complete' && document.documentElement.classList.contains('js')`), 10000, '脚本执行');
    await sleep(300);

    const baseState = await client.evaluate(`(() => ({
      title: document.title,
      year: document.getElementById('currentYear')?.textContent,
      features: document.querySelectorAll('.feature-card').length,
      steps: document.querySelectorAll('.step').length,
      downloadHref: document.querySelector('.header-download')?.getAttribute('href'),
      heroTitle: document.querySelector('.hero-title')?.innerText,
      navLinks: document.querySelectorAll('.nav-link').length,
      cssLoaded: getComputedStyle(document.body).fontFamily.includes('PingFang')
    }))()`);
    console.log('PASS 官网基础渲染', baseState);
    if (baseState.features !== 6) throw new Error('功能卡片数量不正确');
    if (baseState.steps !== 4) throw new Error('安装步骤数量不正确');
    if (!baseState.downloadHref?.includes('imagegrab-v1.0.0.zip')) throw new Error('下载链接缺失');
    if (!baseState.cssLoaded) throw new Error('官网样式未加载');

    const widths = [
      { width: 1440, height: 1000, mobile: false },
      { width: 1024, height: 900, mobile: false },
      { width: 768, height: 900, mobile: true },
      { width: 390, height: 844, mobile: true },
      { width: 320, height: 720, mobile: true }
    ];

    for (const viewport of widths) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.mobile
      });
      await sleep(220);
      const layout = await client.evaluate(`(() => {
        const doc = document.documentElement;
        const nav = document.querySelector('#siteNav');
        const toggle = document.querySelector('#menuToggle');
        const hero = document.querySelector('.hero-copy').getBoundingClientRect();
        return {
          width: innerWidth,
          scrollWidth: doc.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          navDisplay: getComputedStyle(nav).display,
          navVisibility: getComputedStyle(nav).visibility,
          toggleDisplay: getComputedStyle(toggle).display,
          heroRight: Math.round(hero.right),
          heroLeft: Math.round(hero.left)
        };
      })()`);
      console.log(`PASS 响应式 ${viewport.width}px`, layout);
      if (layout.scrollWidth > layout.width + 1 || layout.bodyScrollWidth > layout.width + 1) {
        throw new Error(`${viewport.width}px 下出现横向溢出`);
      }
      if (layout.heroLeft < 0 || layout.heroRight > layout.width + 1) throw new Error('首屏文案溢出视口');
      if (viewport.width <= 900 && layout.toggleDisplay === 'none') throw new Error('移动端菜单按钮未显示');
      if (viewport.width > 900 && layout.toggleDisplay !== 'none') throw new Error('桌面端不应显示菜单按钮');
    }

    await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(200);
    await client.evaluate(`document.querySelector('#menuToggle').click()`);
    await waitFor(async () => client.evaluate(`document.querySelector('#siteNav').classList.contains('is-open') && document.querySelector('#menuToggle').getAttribute('aria-expanded') === 'true' && getComputedStyle(document.querySelector('#siteNav')).visibility === 'visible'`), 3000, '移动端菜单展开');
    const openState = await client.evaluate(`(() => {
      const nav = document.querySelector('#siteNav');
      return { open: nav.classList.contains('is-open'), visibility: getComputedStyle(nav).visibility, links: nav.querySelectorAll('a').length };
    })()`);
    console.log('PASS 移动端菜单展开', openState);
    if (openState.visibility !== 'visible' || openState.links !== 4) throw new Error('移动端菜单内容异常');

    await client.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(async () => client.evaluate(`!document.querySelector('#siteNav').classList.contains('is-open')`), 3000, 'Escape 关闭菜单');
    console.log('PASS 移动端菜单关闭');

    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await sleep(200);

    for (const [selector, hash] of [['#about', '#about'], ['#features', '#features'], ['#install', '#install'], ['#download', '#download']]) {
      await client.evaluate(`document.querySelector('${selector}').scrollIntoView({ block: 'start' })`);
      await sleep(380);
      const active = await client.evaluate(`document.querySelector('.nav-link.is-active')?.getAttribute('href') || ''`);
      console.log('导航高亮', selector, active);
      if (active !== hash) throw new Error(`${selector} 的导航高亮错误：${active}`);
    }

    await client.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
    await sleep(600);
    const finalState = await client.evaluate(`(() => ({
      headerScrolled: document.querySelector('#siteHeader').classList.contains('is-scrolled'),
      visibleReveal: document.querySelectorAll('.reveal.is-visible').length,
      totalReveal: document.querySelectorAll('.reveal').length,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1
    }))()`);
    console.log('PASS 滚动状态', finalState);
    if (!finalState.headerScrolled) throw new Error('导航栏滚动状态未激活');
    if (finalState.horizontalOverflow) throw new Error('桌面端存在横向溢出');

    await client.evaluate(`document.querySelector('#copyExtensions').click()`);
    await waitFor(async () => client.evaluate(`document.querySelector('#toast').classList.contains('is-visible')`), 2500, '复制提示');
    console.log('PASS 复制命令提示');

    if (client.errors.length > 0) {
      throw new Error(`页面脚本异常：${client.errors.join('\n')}`);
    }

    fs.mkdirSync(OUT, { recursive: true });
    const screenshot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, 'desktop.png'), Buffer.from(screenshot.data, 'base64'));
    console.log(`PASS 截图已保存：${path.join(OUT, 'desktop.png')}`);
    console.log('\\nSITE PASS: 官网结构、响应式、菜单、导航高亮、滚动状态与复制功能全部通过。');
  } finally {
    client?.close();
    try { child.kill(); } catch (_error) { /* ignore */ }
    await sleep(400);
  }
}

main().catch((error) => {
  console.error('\\nSITE FAIL:', error.stack || error);
  process.exitCode = 1;
});
