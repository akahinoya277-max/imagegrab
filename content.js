/**
 * 图提取 ImageGrab - 内容脚本
 *
 * 职责：
 * 1. 只在受支持平台的商品详情页注入悬浮按钮；
 * 2. 点击后扫描 img / srcset / 懒加载属性 / CSS 背景图 / 商品元数据；
 * 3. 做 URL 归一化、去重和基础过滤，然后把列表交给 Service Worker。
 */
(function initImageGrabContent() {
  'use strict';

  const Core = globalThis.ImageGrabCore;
  if (!Core) {
    console.error('[图提取] 共享工具未加载，内容脚本已停止。');
    return;
  }

  const MIN_IMAGE_SIZE = 100;
  const BUTTON_ID = 'imagegrab-fab';
  const BUTTON_ROOT_ID = 'imagegrab-root';
  const FEEDBACK_RESET_MS = 2800;
  const BACKGROUND_SCAN_CHUNK = 240;
  const MAX_ALT_LENGTH = 120;

  const state = {
    button: null,
    scanning: false,
    feedbackTimer: 0,
    routeTimer: 0,
    lastHref: location.href,
    initialized: false
  };

  const ICON_SVG = `
    <svg class="imagegrab-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="15" rx="3" stroke="currentColor" stroke-width="1.8"></rect>
      <circle cx="8.3" cy="9.4" r="1.5" fill="currentColor"></circle>
      <path d="M4.5 16.5 9 12.1l3.1 3.1 2.4-2.2 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="M17.5 3v5.3M15.3 6.1l2.2 2.2 2.2-2.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `;

  /** 判断当前地址是否应显示按钮；URL 规则为主，页面结构化信息作补充 */
  function isEligiblePage() {
    if (!Core.isSupportedHost(location.hostname)) return false;
    if (Core.isProductDetailUrl(location.href)) return true;

    // 部分平台会更换路径写法；只有同时存在商品 ID 与结构化商品信号时才启用。
    if (!Core.extractProductId(location.href)) return false;
    if (!/(?:item|goods|product|detail|sku)/i.test(location.pathname)) return false;

    const ogType = [...document.querySelectorAll('meta[property="og:type"]')].some(
      (meta) => String(meta.getAttribute('content') || '').toLowerCase() === 'product'
    );
    if (ogType) return true;

    const hasMicrodata = Boolean(document.querySelector('[itemtype*="Product"]'));
    if (hasMicrodata) return true;

    const hasProductSchema = [...document.querySelectorAll('script[type="application/ld+json"]')].some(
      (script) => /"@type"\s*:\s*(?:"Product"|\[[^\]]*"Product")/i.test(script.textContent || '')
    );
    if (hasProductSchema) return true;

    return /商品详情|宝贝详情|商品介绍/.test(document.title) &&
      /(?:item|goods|product|detail|sku)/i.test(location.pathname);
  }

  function setButtonVisual(kind, label) {
    if (!state.button) return;
    state.button.dataset.state = kind;
    const labelNode = state.button.querySelector('.imagegrab-label');
    if (labelNode) labelNode.textContent = label;
    state.button.setAttribute('aria-label', `${label}，图提取`);
    state.button.setAttribute('aria-busy', kind === 'loading' ? 'true' : 'false');
    state.button.disabled = kind === 'loading';
  }

  function resetButtonVisual() {
    window.clearTimeout(state.feedbackTimer);
    state.feedbackTimer = 0;
    if (state.scanning) return;
    setButtonVisual('idle', '获取图片');
  }

  function showTemporaryButtonState(kind, label, duration = FEEDBACK_RESET_MS) {
    if (!state.button) return;
    window.clearTimeout(state.feedbackTimer);
    setButtonVisual(kind, label);
    state.feedbackTimer = window.setTimeout(resetButtonVisual, duration);
  }

  function removeButton() {
    window.clearTimeout(state.feedbackTimer);
    state.feedbackTimer = 0;
    if (state.button) {
      state.button.remove();
      state.button = null;
    }
    const staleRoot = document.getElementById(BUTTON_ROOT_ID);
    if (staleRoot) staleRoot.remove();
  }

  function mountButton() {
    if (state.button && state.button.isConnected) return state.button;
    if (!document.body) return null;

    removeButton();

    // 用一个独立容器隔离第三方页面可能设置的通用 button/span 样式。
    const root = document.createElement('div');
    root.id = BUTTON_ROOT_ID;
    root.setAttribute('data-imagegrab-ui', 'true');

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.dataset.state = 'idle';
    button.title = '扫描当前商品页中的图片并打开预览';
    button.setAttribute('aria-label', '获取图片，图提取');
    button.setAttribute('aria-busy', 'false');
    button.innerHTML = `
      ${ICON_SVG}
      <span class="imagegrab-label">获取图片</span>
      <span class="imagegrab-spinner" aria-hidden="true"></span>
    `;
    button.addEventListener('click', handleExtractClick);

    root.appendChild(button);
    document.body.appendChild(root);
    state.button = button;
    if (state.scanning) setButtonVisual('loading', '正在提取…');
    return button;
  }

  function syncButtonVisibility() {
    const hrefChanged = state.lastHref !== location.href;
    if (hrefChanged) {
      state.lastHref = location.href;
      if (!state.scanning) resetButtonVisual();
    }

    if (isEligiblePage()) {
      mountButton();
    } else {
      removeButton();
    }
  }

  function parseDimension(value) {
    const parsed = Number.parseFloat(String(value || '').replace(/[^\d.]/g, ''));
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
  }

  function getImageDimensions(img) {
    const naturalWidth = Number(img.naturalWidth) || 0;
    const naturalHeight = Number(img.naturalHeight) || 0;
    const rect = typeof img.getBoundingClientRect === 'function' ? img.getBoundingClientRect() : null;
    const attrWidth = parseDimension(img.getAttribute('width'));
    const attrHeight = parseDimension(img.getAttribute('height'));

    return {
      naturalWidth,
      naturalHeight,
      width: naturalWidth || attrWidth || Math.round(rect?.width || 0),
      height: naturalHeight || attrHeight || Math.round(rect?.height || 0)
    };
  }

  function truncateText(value, maxLength) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  }

  /**
   * 从一个 img 的多个来源里选出“最像原图”的一个。
   * 越靠前的 data-* 属性优先级越高；srcset 取最高分辨率；currentSrc 与 src 兜底。
   */
  function chooseImageSource(img) {
    const baseUrl = img.baseURI || document.baseURI;
    const candidates = [];

    const pushCandidate = (rawValue, source, priority) => {
      const url = Core.normalizeImageUrl(rawValue, baseUrl);
      if (!url || Core.isDecorativeImageUrl(url)) return;
      candidates.push({ url, source, priority });
    };

    Core.IMAGE_ATTRIBUTES.forEach((attribute, index) => {
      pushCandidate(img.getAttribute(attribute), attribute, 300 - index);
    });

    Core.SRCSET_ATTRIBUTES.forEach((attribute, index) => {
      const best = Core.pickBestFromSrcset(img.getAttribute(attribute), baseUrl);
      if (best) pushCandidate(best, attribute, 220 - index);
    });

    // 懒加载图片加载完成前 currentSrc 可能为空或仍是占位图，故优先级低于显式原图属性。
    if (img.currentSrc) pushCandidate(img.currentSrc, 'currentSrc', 120);
    pushCandidate(img.getAttribute('src'), 'src', 90);

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.priority - a.priority);

    // 同一张图可能同时有 src 和 srcset，只保留选中的最优地址，避免画廊重复。
    return candidates[0];
  }

  /** 扫描页面上所有元素的实际 CSS background-image，以及平台常见的懒加载背景属性 */
  async function scanBackgroundImages(addCandidate) {
    const elements = new Set();
    if (document.documentElement) elements.add(document.documentElement);
    if (document.body) elements.add(document.body);
    document.querySelectorAll('body *').forEach((element) => elements.add(element));

    let index = 0;
    for (const element of elements) {
      index += 1;

      if (element.id === BUTTON_ROOT_ID || element.closest?.(`#${BUTTON_ROOT_ID}`)) continue;
      const tagName = element.tagName;
      if (['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE'].includes(tagName)) continue;

      const urls = new Set();

      // 懒加载背景图经常放在 data-* 中，页面尚未触发加载时只能从这里获取。
      for (const attribute of [
        'data-bg',
        'data-background',
        'data-background-image',
        'data-lazy-bg',
        'data-lazy-background',
        'data-bg-src'
      ]) {
        const value = element.getAttribute?.(attribute);
        if (value) Core.extractBackgroundUrls(value).forEach((url) => urls.add(url));
      }

      // data-style 是部分平台延迟注入的完整样式文本。
      const dataStyle = element.getAttribute?.('data-style');
      if (dataStyle && /background/i.test(dataStyle)) {
        Core.extractBackgroundUrls(dataStyle).forEach((url) => urls.add(url));
      }

      try {
        const computed = window.getComputedStyle(element);
        if (computed && computed.backgroundImage && computed.backgroundImage !== 'none') {
          Core.extractBackgroundUrls(computed.backgroundImage).forEach((url) => urls.add(url));
        }
      } catch (_error) {
        // 某些浏览器扩展或特殊节点会让 getComputedStyle 抛错，跳过该节点即可。
      }

      if (urls.size > 0) {
        const rect = element.getBoundingClientRect?.();
        for (const rawUrl of urls) {
          addCandidate(rawUrl, {
            source: 'background',
            width: Math.round(rect?.width || 0),
            height: Math.round(rect?.height || 0),
            alt: element.getAttribute?.('aria-label') || ''
          });
        }
      }

      // 分片扫描，避免一次性读取几千个节点的样式导致页面卡顿。
      if (index % BACKGROUND_SCAN_CHUNK === 0) {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }
  }

  /** 从 og:image、twitter:image、link[rel=image_src] 与 Product JSON-LD 补充商品主图 */
  function scanProductMetadata(addCandidate) {
    const selectors = [
      'meta[property="og:image"]',
      'meta[property="og:image:secure_url"]',
      'meta[name="twitter:image"]',
      'meta[name="twitter:image:src"]',
      'link[rel="image_src"]'
    ];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const value = node.getAttribute('content') || node.getAttribute('href');
        if (value) addCandidate(value, { source: 'meta', width: 0, height: 0, alt: '' });
      }
    }

    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      const body = script.textContent || '';
      if (!/"@type"\s*:\s*(?:"Product"|\[[^\]]*"Product")/i.test(body)) continue;
      try {
        const parsed = JSON.parse(body);
        const products = [];
        collectObjectsByType(parsed, 'Product', products, 0);
        for (const product of products) {
          const images = Array.isArray(product.image) ? product.image : [product.image];
          for (const image of images) {
            const value = typeof image === 'string' ? image : image?.url || image?.contentUrl;
            if (value) addCandidate(value, { source: 'jsonld', width: 0, height: 0, alt: '' });
          }
        }
      } catch (_error) {
        // 页面中的 JSON-LD 不一定合法，忽略即可，不影响常规图片扫描。
      }
    }
  }

  function collectObjectsByType(value, wantedType, output, depth) {
    if (!value || typeof value !== 'object' || depth > 8) return;
    if (Array.isArray(value)) {
      for (const item of value) collectObjectsByType(item, wantedType, output, depth + 1);
      return;
    }
    const type = value['@type'];
    const hasType = Array.isArray(type) ? type.includes(wantedType) : type === wantedType;
    if (hasType) output.push(value);
    for (const key of Object.keys(value)) {
      if (key === 'review' || key === 'offers') continue;
      collectObjectsByType(value[key], wantedType, output, depth + 1);
    }
  }

  /**
   * 扫描整页并返回去重后的图片记录。
   * 过滤顺序：URL 级装饰图过滤 → 已知尺寸过滤 → URL 去重。
   */
  async function collectPageImages() {
    const imageMap = new Map();
    let order = 0;

    const addCandidate = (rawUrl, options = {}) => {
      const url = Core.normalizeImageUrl(rawUrl, document.baseURI);
      if (!url || Core.isDecorativeImageUrl(url)) return;

      const width = Math.max(0, Math.round(Number(options.width) || 0));
      const height = Math.max(0, Math.round(Number(options.height) || 0));
      if (Core.isBelowMinImageSize(width, height, MIN_IMAGE_SIZE)) return;

      const existing = imageMap.get(url);
      if (existing) {
        // 同一 URL 被多处引用时合并更可靠的尺寸和 alt 信息。
        if (width * height > existing.width * existing.height) {
          existing.width = width;
          existing.height = height;
        }
        if (!existing.alt && options.alt) existing.alt = truncateText(options.alt, MAX_ALT_LENGTH);
        return;
      }

      imageMap.set(url, {
        url,
        width,
        height,
        source: String(options.source || 'unknown').slice(0, 32),
        alt: truncateText(options.alt, MAX_ALT_LENGTH),
        order: order++
      });
    };

    // 1) 普通 img：兼容 srcset、data-* 懒加载和已加载原图。
    document.querySelectorAll('img').forEach((img) => {
      const chosen = chooseImageSource(img);
      if (!chosen) return;

      const dimensions = getImageDimensions(img);
      const resolvedCurrent = Core.normalizeImageUrl(img.currentSrc || '', img.baseURI);
      const resolvedSrc = Core.normalizeImageUrl(img.getAttribute('src') || '', img.baseURI);
      const isLoadedSource = chosen.url === resolvedCurrent || chosen.url === resolvedSrc;
      const isLazyOriginal = chosen.source.startsWith('data-');

      // naturalWidth/naturalHeight 是真实解码尺寸，只有它对应本次选中的 URL 时才可安全过滤。
      if (isLoadedSource && Core.isBelowMinImageSize(
        dimensions.naturalWidth,
        dimensions.naturalHeight,
        MIN_IMAGE_SIZE
      )) return;

      // 没有原图属性、也没有解码尺寸时，用元素尺寸过滤明显的小图标。
      if (!isLazyOriginal && !dimensions.naturalWidth && Core.isBelowMinImageSize(
        dimensions.width,
        dimensions.height,
        MIN_IMAGE_SIZE
      )) return;

      // 懒加载原图尚未解码时，页面上的 naturalWidth 往往属于占位图，尺寸不可信。
      // 此时先不填尺寸，画廊加载原图后会补上真实宽高并执行最终的小图判断。
      const hasTrustedSize = isLoadedSource || (!isLazyOriginal && dimensions.naturalWidth > 0);
      const reportWidth = hasTrustedSize ? dimensions.width : 0;
      const reportHeight = hasTrustedSize ? dimensions.height : 0;

      addCandidate(chosen.url, {
        source: chosen.source,
        width: reportWidth,
        height: reportHeight,
        alt: img.getAttribute('alt') || ''
      });
    });

    // 2) picture > source 的 srcset（即使当前视口没有加载也保留候选）。
    document.querySelectorAll('source[srcset], source[data-srcset]').forEach((source) => {
      const raw = source.getAttribute('srcset') || source.getAttribute('data-srcset');
      const best = Core.pickBestFromSrcset(raw, source.baseURI || document.baseURI);
      if (best) addCandidate(best, { source: 'picture-srcset', width: 0, height: 0, alt: '' });
    });

    // 3) 商品元数据与 JSON-LD 主图。
    scanProductMetadata(addCandidate);

    // 4) 所有元素的实际背景图与懒加载背景属性。
    await scanBackgroundImages(addCandidate);

    return [...imageMap.values()].sort((a, b) => a.order - b.order);
  }

  async function handleExtractClick() {
    if (state.scanning || !state.button) return;
    if (!isEligiblePage()) {
      removeButton();
      return;
    }

    state.scanning = true;
    window.clearTimeout(state.feedbackTimer);
    setButtonVisual('loading', '正在提取…');

    try {
      // 先让浏览器完成一次绘制，确保用户看到 loading 状态。
      await new Promise((resolve) => window.setTimeout(resolve, 60));
      const images = await collectPageImages();

      if (images.length === 0) {
        showTemporaryButtonState('empty', '未找到商品图', 3200);
        return;
      }

      const response = await chrome.runtime.sendMessage({
        type: 'IMAGEGRAB_CAPTURE',
        payload: {
          page: {
            url: location.href,
            title: truncateText(document.title, 160),
            host: location.hostname,
            platform: Core.getPlatformName(location.href)
          },
          images
        }
      });

      if (!response?.ok) {
        throw new Error(response?.error || '后台未能创建图片列表');
      }

      showTemporaryButtonState('success', `已提取 ${images.length} 张`, 2200);
    } catch (error) {
      console.error('[图提取] 提取失败：', error);
      const message = /Extension context invalidated/i.test(String(error?.message))
        ? '请刷新页面后重试'
        : '提取失败，请重试';
      showTemporaryButtonState('error', message, 3200);
    } finally {
      state.scanning = false;
      if (state.button) state.button.disabled = false;
      if (state.button) state.button.setAttribute('aria-busy', 'false');
    }
  }

  function startRouteWatcher() {
    // pushState 路由不会触发 popstate，用轻量轮询覆盖淘宝/京东/拼多多的 SPA 跳转。
    state.routeTimer = window.setInterval(syncButtonVisibility, 1000);
    window.addEventListener('popstate', syncButtonVisibility);
    window.addEventListener('hashchange', syncButtonVisibility);

    // 首屏 DOM 可能比 document_idle 更晚渲染，延迟再检查一次。
    window.setTimeout(syncButtonVisibility, 500);
    window.setTimeout(syncButtonVisibility, 1800);
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    startRouteWatcher();
    syncButtonVisibility();

    window.addEventListener('pagehide', () => {
      window.clearInterval(state.routeTimer);
      removeButton();
    }, { once: true });
  }

  init();
})();
