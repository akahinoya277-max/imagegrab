/**
 * 图提取 ImageGrab - Service Worker
 *
 * 职责：
 * 1. 接收内容脚本的图片列表，暂存到 storage.session，并打开画廊页；
 * 2. 处理画廊的下载长连接，逐张转换为 PNG 并写入默认下载目录；
 * 3. 持续推送单张进度、成功/失败结果，任务结束后释放资源。
 */
'use strict';

importScripts(
  'lib/image-core.js',
  'lib/session-store.js',
  'lib/downloader.js'
);

const Core = globalThis.ImageGrabCore;
const CaptureStore = globalThis.ImageGrabCaptureStore;
const Downloader = globalThis.ImageGrabDownloader;

const GALLERY_PAGE = 'gallery.html';
const DOWNLOAD_PORT = 'imagegrab-download';
const MAX_CAPTURE_IMAGES = 5000;
const MAX_URL_LENGTH = 8000;
const MAX_ALT_LENGTH = 160;
const BADGE_CLEAR_MS = 4500;

if (!Core || !CaptureStore || !Downloader) {
  console.error('[图提取] 后台依赖加载失败，请重新安装扩展。');
}

/** 生成不依赖第三方库的捕获 ID */
function createCaptureId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `ig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeInteger(value, max = 100000) {
  const number = Math.round(Number(value) || 0);
  return Math.min(max, Math.max(0, number));
}

function trims(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * 将内容脚本传入的数据整理成可信的捕获记录。
 * 页面 URL 以 sender.tab.url 为准，图片地址重新做 HTTP(S) 校验和去重。
 */
function buildCapture(payload, sender) {
  const sourceUrl = String(sender?.tab?.url || payload?.page?.url || '');
  let pageUrl;
  try {
    pageUrl = new URL(sourceUrl);
  } catch (_error) {
    throw new Error('无法识别当前商品页地址');
  }

  if (!/^https?:$/.test(pageUrl.protocol) || !Core.isSupportedHost(pageUrl.hostname)) {
    throw new Error('当前页面不在支持的商品平台范围内');
  }

  const rawImages = Array.isArray(payload?.images) ? payload.images : [];
  const images = [];
  const seen = new Set();

  for (const rawImage of rawImages) {
    if (images.length >= MAX_CAPTURE_IMAGES) break;
    if (!rawImage || typeof rawImage.url !== 'string' || rawImage.url.length > MAX_URL_LENGTH) {
      continue;
    }

    const url = Core.normalizeImageUrl(rawImage.url, pageUrl.href);
    if (!url || seen.has(url) || Core.isDecorativeImageUrl(url)) continue;

    const width = normalizeInteger(rawImage.width);
    const height = normalizeInteger(rawImage.height);
    if (Core.isBelowMinImageSize(width, height, 100)) continue;

    seen.add(url);
    images.push({
      url,
      width,
      height,
      source: trims(rawImage.source || 'unknown', 32) || 'unknown',
      alt: trims(rawImage.alt, MAX_ALT_LENGTH),
      order: images.length
    });
  }

  if (images.length === 0) throw new Error('没有可展示的商品图片');

  const createdAt = Date.now();
  return {
    version: 1,
    id: createCaptureId(),
    createdAt,
    page: {
      url: pageUrl.href,
      title: trims(payload?.page?.title || sender?.tab?.title || '商品详情页', 180),
      host: pageUrl.hostname,
      platform: Core.getPlatformName(pageUrl.href)
    },
    images
  };
}

function setCaptureBadge(tabId, count) {
  if (!Number.isInteger(tabId)) return;

  try {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#4f46e5' }, () => {
      void chrome.runtime.lastError;
    });
    chrome.action.setBadgeText(
      { tabId, text: count > 99 ? '99+' : String(count) },
      () => {
        void chrome.runtime.lastError;
      }
    );

    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: '' }, () => {
        void chrome.runtime.lastError;
      });
    }, BADGE_CLEAR_MS);
  } catch (_error) {
    // 徽标只是增强反馈，失败不应影响提取主流程。
  }
}

/** 收到内容脚本的图片列表：存储 → 新标签页打开画廊 */
async function handleCapture(payload, sender) {
  const capture = buildCapture(payload, sender);
  await CaptureStore.save(capture);

  const galleryUrl = new URL(chrome.runtime.getURL(GALLERY_PAGE));
  galleryUrl.searchParams.set('capture', capture.id);

  let tab;
  try {
    tab = await chrome.tabs.create({ url: galleryUrl.href, active: true });
  } catch (error) {
    throw new Error(`无法打开图片画廊：${error?.message || '未知错误'}`);
  }

  setCaptureBadge(sender?.tab?.id, capture.images.length);
  return {
    ok: true,
    captureId: capture.id,
    count: capture.images.length,
    tabId: tab?.id
  };
}

async function handleGetCapture(captureId) {
  const capture = captureId
    ? await CaptureStore.get(String(captureId))
    : await CaptureStore.latest();

  if (!capture) {
    return { ok: false, error: '没有可用的提取记录，请回到商品页重新提取。' };
  }

  return { ok: true, capture };
}

/**
 * 串行下载，保证「商品图_001.png」与选中顺序一致。
 * 每张完成后才继续下一张，进度清晰，也避免瞬间起大量网络请求。
 */
async function runDownloadJob({ captureId, urls, post, signal, startedAt = Date.now() }) {
  const capture = await CaptureStore.get(String(captureId || ''));
  if (!capture) {
    throw new Downloader.JobError('CAPTURE_NOT_FOUND', '图片列表已过期，请重新提取后再下载。');
  }

  const allowedUrls = new Set(capture.images.map((image) => image.url));
  const selected = [];
  const seen = new Set();

  for (const rawUrl of Array.isArray(urls) ? urls : []) {
    const url = typeof rawUrl === 'string' ? rawUrl : '';
    if (!allowedUrls.has(url) || seen.has(url)) continue;
    seen.add(url);
    selected.push(url);
    if (selected.length >= capture.images.length) break;
  }

  if (selected.length === 0) {
    throw new Downloader.JobError('NO_SELECTION', '请至少选择一张图片后再下载。');
  }

  const total = selected.length;
  let completed = 0;
  let succeeded = 0;
  let failed = 0;
  const results = [];

  post({ type: 'STARTED', total, startedAt });

  for (let index = 0; index < selected.length; index += 1) {
    if (signal.aborted) break;

    const url = selected[index];
    const filename = Core.buildImageFileName(index + 1, '商品图');
    const progressBase = {
      type: 'PROGRESS',
      total,
      completed,
      succeeded,
      failed,
      currentIndex: index + 1,
      filename
    };

    // processAndDownload 会在取图、转码、编码、保存四个阶段回调。
    try {
      const outcome = await Downloader.processAndDownload(url, filename, signal, (phase) => {
        post({ ...progressBase, phase });
      });

      completed += 1;
      succeeded += 1;
      const result = {
        ok: true,
        index: index + 1,
        url,
        filename: outcome.filename || filename,
        downloadId: outcome.downloadId,
        pngBytes: outcome.pngBytes,
        fileSize: outcome.fileSize
      };
      results.push(result);
      post({
        type: 'ITEM_DONE',
        completed,
        total,
        succeeded,
        failed,
        result
      });
    } catch (error) {
      if (signal.aborted || Downloader.isAbortError(error, signal)) break;

      completed += 1;
      failed += 1;
      const result = {
        ok: false,
        index: index + 1,
        url,
        filename,
        error: Downloader.getUserErrorMessage(error),
        errorCode: error?.code || 'UNKNOWN'
      };
      results.push(result);
      console.warn('[图提取] 单张图片下载失败：', error);
      post({
        type: 'ITEM_DONE',
        completed,
        total,
        succeeded,
        failed,
        result
      });
    }

    post({
      type: 'PROGRESS',
      phase: signal.aborted ? 'cancelled' : 'item-complete',
      total,
      completed,
      succeeded,
      failed,
      currentIndex: index + 1,
      filename
    });
  }

  const payload = {
    type: 'DONE',
    total,
    completed,
    succeeded,
    failed,
    cancelled: signal.aborted,
    durationMs: Date.now() - startedAt,
    results
  };
  post(payload);
}

function startKeepAlive() {
  // 转换和等待下载可能超过 30 秒；每 20 秒调用一次轻量扩展 API，防止 SW 空闲退出。
  return setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => {
        void chrome.runtime.lastError;
      });
    } catch (_error) {
      // 忽略：Service Worker 生命周期由浏览器管理。
    }
  }, 20000);
}

/** 画廊通过长连接发起下载，即可持续收到进度，而不用轮询 storage */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== DOWNLOAD_PORT) return;

  let started = false;
  let disconnected = false;
  let controller = null;
  let keepAliveTimer = 0;

  const post = (message) => {
    if (disconnected) return;
    try {
      port.postMessage(message);
    } catch (_error) {
      disconnected = true;
    }
  };

  const stopKeepAlive = () => {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = 0;
  };

  port.onMessage.addListener((message) => {
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'CANCEL') {
      if (controller && !controller.signal.aborted) controller.abort();
      return;
    }

    if (message.type !== 'START_DOWNLOADS') return;
    if (started) {
      post({ type: 'ERROR', error: '当前下载任务已开始，请关闭画廊后重试。' });
      return;
    }

    started = true;
    controller = new AbortController();
    keepAliveTimer = startKeepAlive();

    runDownloadJob({
      captureId: message.captureId,
      urls: message.urls,
      post,
      signal: controller.signal
    })
      .catch((error) => {
        console.error('[图提取] 下载任务失败：', error);
        post({
          type: 'ERROR',
          error: Downloader.getUserErrorMessage(error)
        });
      })
      .finally(() => {
        stopKeepAlive();
        controller = null;
      });
  });

  port.onDisconnect.addListener(() => {
    disconnected = true;
    if (controller && !controller.signal.aborted) controller.abort();
    stopKeepAlive();
    void chrome.runtime.lastError;
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'IMAGEGRAB_CAPTURE') {
    handleCapture(message.payload, sender)
      .then(sendResponse)
      .catch((error) => {
        console.error('[图提取] 创建图片列表失败：', error);
        sendResponse({ ok: false, error: error?.message || '提取失败' });
      });
    return true;
  }

  if (message.type === 'IMAGEGRAB_GET_CAPTURE') {
    handleGetCapture(message.captureId)
      .then(sendResponse)
      .catch((error) => {
        console.error('[图提取] 读取图片列表失败：', error);
        sendResponse({ ok: false, error: error?.message || '读取失败' });
      });
    return true;
  }

  return false;
});

// 没有 popup 时，点击扩展图标直接打开最近一次画廊；无记录时画廊展示引导空状态。
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL(GALLERY_PAGE) }).catch((error) => {
    console.error('[图提取] 无法打开画廊：', error);
  });
});
