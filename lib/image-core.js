/**
 * 图提取 ImageGrab - 共享纯函数
 *
 * 这个文件不依赖 DOM 或 chrome.* API，可同时被以下环境使用：
 * - 内容脚本（普通 <script>，暴露到 globalThis.ImageGrabCore）
 * - Service Worker（importScripts）
 * - 画廊页（普通 <script>）
 * - Node.js 单元测试（module.exports）
 */
(function initImageGrabCore(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ImageGrabCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createImageGrabCore() {
  'use strict';

  /** 内容脚本与后台共同认可的详情页域名后缀 */
  const PLATFORM_HOST_SUFFIXES = Object.freeze([
    'taobao.com',
    'tmall.com',
    'jd.com',
    'pinduoduo.com',
    'yangkeduo.com'
  ]);

  /** 常见图片 CDN；用于画廊提示、可选权限申请和测试 */
  const IMAGE_HOST_SUFFIXES = Object.freeze([
    ...PLATFORM_HOST_SUFFIXES,
    'alicdn.com',
    '360buyimg.com',
    'jdimg.com',
    'pddpic.com'
  ]);

  /** 商品页中可能存放原图地址的属性，按“原图可能性”从高到低排列 */
  const IMAGE_ATTRIBUTES = Object.freeze([
    'data-original',
    'data-origin',
    'data-original-src',
    'data-large',
    'data-big',
    'data-oss',
    'data-ossrc',
    'data-actualsrc',
    'data-lazy-src',
    'data-lazyload',
    'data-lazy',
    'data-src',
    'data-ks-lazyload',
    'data-url',
    'data-image',
    'data-echo',
    'data-lazy-img',
    'data-image-src',
    'data-src-original'
  ]);

  const SRCSET_ATTRIBUTES = Object.freeze(['srcset', 'data-srcset', 'data-lazy-srcset']);
  const PRODUCT_ID_KEYS = Object.freeze([
    'id',
    'item_id',
    'itemId',
    'goods_id',
    'goodsId',
    'product_id',
    'productId',
    'sku_id',
    'skuId',
    'ware_id',
    'wareId'
  ]);

  /** 判断 hostname 是否等于某个后缀域名或其子域名 */
  function hostMatches(hostname, suffixes) {
    const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  }

  function isSupportedHost(hostname) {
    return hostMatches(hostname, PLATFORM_HOST_SUFFIXES);
  }

  function getPlatformName(rawUrl) {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (hostMatches(host, ['taobao.com'])) return '淘宝';
      if (hostMatches(host, ['tmall.com'])) return '天猫';
      if (hostMatches(host, ['jd.com'])) return '京东';
      if (hostMatches(host, ['pinduoduo.com'])) return '拼多多';
      if (hostMatches(host, ['yangkeduo.com'])) return '拼多多';
    } catch (_error) {
      // 非法 URL 统一返回空字符串，避免调用方反复 try/catch。
    }
    return '';
  }

  function getHostLabel(rawUrl) {
    try {
      return new URL(rawUrl).hostname.replace(/^www\./, '');
    } catch (_error) {
      return '';
    }
  }

  /**
   * 从 URL 中提取商品标识。
   * 淘宝类页面通常使用 id，拼多多使用 goods_id，京东 mobile 页则常把 id 放在路径里。
   */
  function hasProductIdentifier(url) {
    for (const key of PRODUCT_ID_KEYS) {
      const value = url.searchParams.get(key);
      if (value && /^\d{5,}$/.test(value.trim())) return true;
    }

    // 覆盖 /item/123456.html、/product/123456、/goods_123456 等常见写法
    return /(?:^|[/_-])\d{5,}(?:[./_-]|$)/.test(url.pathname);
  }

  /**
   * 判断当前 URL 是否属于受支持平台的商品详情页。
   * 采用“域名 + 路径 + 商品 ID”三重判断，避免在首页、搜索页、登录页误显示按钮。
   */
  function isProductDetailUrl(rawUrl) {
    let url;
    try {
      url = new URL(String(rawUrl));
    } catch (_error) {
      return false;
    }

    if (!/^https?:$/.test(url.protocol) || !isSupportedHost(url.hostname)) return false;

    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    const hasId = hasProductIdentifier(url);

    // 京东：PC 商品页 /123456.html，移动端 /product/123456.html
    if (host === 'item.jd.com') return /^\/\d{5,}\.html$/.test(path);
    if (host === 'item.m.jd.com') return /^\/product\/\d{5,}(?:\.html)?$/.test(path);
    if (host === 'npcitem.jd.hk') return /^\/\d{5,}\.html$/.test(path);

    // 拼多多商家后台：/goods/goods_detail?goods_id=...
    if (host === 'mms.pinduoduo.com') {
      return (
        /^\/goods\/(?:goods[_-]?)?detail(?:[/_.]|$)/.test(path) ||
        ((/^\/goods\//.test(path) || path.includes('/goods_detail')) && hasId)
      );
    }

    // 拼多多 / 多多进宝移动商品页
    if (hostMatches(host, ['yangkeduo.com', 'pinduoduo.com'])) {
      if (/^\/(?:goods|goods2|goods[_-]detail|goods-detail)(?:\.html)?(?:[/_.]|$)/.test(path)) {
        return hasId || /[?&]goods_id=/i.test(url.search);
      }
    }

    // 淘宝、天猫：item.htm?id=...、/item/123456.htm、部分新版详情路由
    if (hostMatches(host, ['taobao.com', 'tmall.com'])) {
      if (/\/item(?:\.htm|\/)/.test(path) || /\/detail(?:[/_.]|$)/.test(path)) {
        return hasId || /[?&](?:id|item_id)=/i.test(url.search);
      }
    }

    // 平台新版路由兜底：路径出现商品语义 + 有效商品 ID
    return hasId && /(?:item|goods|product|detail|sku)/i.test(path);
  }

  /**
   * 将任意图片地址转为可直接请求的 HTTP(S) 绝对地址。
   * 拒绝 data:、blob: 等无法交给 downloads API 稳定保存的协议。
   */
  function normalizeImageUrl(rawValue, baseUrl) {
    if (typeof rawValue !== 'string') return null;

    let value = rawValue.trim();
    if (!value || value === '#' || /^javascript:/i.test(value) || /^about:/i.test(value)) {
      return null;
    }

    // 兼容 CSS 的 url("...") 以及 HTML 实体
    const cssUrlMatch = value.match(/^url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)$/i);
    if (cssUrlMatch) value = (cssUrlMatch[2] || cssUrlMatch[3] || '').trim();
    value = value
      .replace(/^['"]|['"]$/g, '')
      .replace(/&amp;/gi, '&')
      .replace(/\\\//g, '/')
      .trim();

    if (!value || /^(?:data|blob|filesystem|chrome|chrome-extension):/i.test(value)) return null;
    if (value.startsWith('#')) return null;

    // 协议相对地址在电商 CDN 中非常常见
    if (value.startsWith('//')) value = `https:${value}`;

    try {
      const url = new URL(value, baseUrl || undefined);
      if (!/^https?:$/.test(url.protocol)) return null;
      url.hash = '';
      return url.href;
    } catch (_error) {
      return null;
    }
  }

  /** 提取 style / CSS 文本里的全部 url(...) */
  function extractBackgroundUrls(value) {
    if (typeof value !== 'string' || !value.trim()) return [];
    const urls = [];
    const re = /url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/gi;
    let match;
    while ((match = re.exec(value)) !== null) {
      const candidate = (match[2] || match[3] || '').trim();
      if (candidate) urls.push(candidate);
    }
    return urls;
  }

  /**
   * 解析 srcset，返回 [{url, descriptor, score}]。
   * 正常 srcset 里的 URL 不应含未编码逗号；这里仍按括号深度切分，兼容部分不规范页面。
   */
  function parseSrcset(srcset, baseUrl) {
    if (typeof srcset !== 'string' || !srcset.trim()) return [];

    const entries = [];
    let buffer = '';
    let depth = 0;
    for (const char of srcset) {
      if (char === '(') depth += 1;
      if (char === ')' && depth > 0) depth -= 1;
      if (char === ',' && depth === 0) {
        if (buffer.trim()) entries.push(buffer.trim());
        buffer = '';
      } else {
        buffer += char;
      }
    }
    if (buffer.trim()) entries.push(buffer.trim());

    return entries
      .map((entry, index) => {
        const parts = entry.trim().split(/\s+/);
        const rawUrl = (parts.shift() || '').replace(/,+$/, '');
        const url = normalizeImageUrl(rawUrl, baseUrl);
        if (!url) return null;

        const descriptor = parts.join(' ').trim();
        const match = descriptor.match(/^(\d+(?:\.\d+)?)([wx])$/i);
        const value = match ? Number(match[1]) : 0;
        // 用较大的基准让 2x 图优先于普通 800w 图；同类型仍按数值排序。
        const score = match ? value * (match[2].toLowerCase() === 'x' ? 1000 : 1) : 1;
        return { url, descriptor, score, index };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.index - b.index);
  }

  function pickBestFromSrcset(srcset, baseUrl) {
    const parsed = parseSrcset(srcset, baseUrl);
    return parsed.length > 0 ? parsed[0].url : null;
  }

  /**
   * 排除图标、logo、占位图、埋点像素等明显不是商品图的 URL。
   * 这是一层 URL 级预过滤，最终还会用真实尺寸和页面上下文再次判断。
   */
  function isDecorativeImageUrl(rawUrl) {
    let url;
    try {
      url = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl));
    } catch (_error) {
      return true;
    }

    if (!/^https?:$/.test(url.protocol)) return true;
    if (/\.(?:svg|ico)$/i.test(url.pathname)) return true;

    const pathname = url.pathname.toLowerCase();
    const basename = pathname.split('/').pop() || '';
    const decorativeName =
      /(?:^|[-_./])(logo|icon|sprite|avatar|favicon|placeholder|blank|spacer|transparent|pixel|tracking|qrcode|qr-code|no-image|nopic|default-img)(?:[-_./]|$)/i;
    if (decorativeName.test(basename) || decorativeName.test(pathname)) return true;

    if (/(?:^|[/_.-])(?:1x1|spacer|blank|transparent|loading)(?:[/_.-]|$)/i.test(pathname)) {
      return true;
    }

    // CDN 常用 _60x60.jpg、-80x80、/120x90/ 表示缩略图，已知两边都小于 100 时剔除
    const sizeMatches = pathname.match(/(?:^|[/_.@-])(\d{1,3})x(\d{1,3})(?=[/_.@-]|$)/gi) || [];
    for (const token of sizeMatches) {
      const numbers = token.match(/(\d{1,3})x(\d{1,3})/i);
      if (numbers && Number(numbers[1]) < 100 && Number(numbers[2]) < 100) return true;
    }

    const widthParam = Number(url.searchParams.get('w') || url.searchParams.get('width') || 0);
    const heightParam = Number(url.searchParams.get('h') || url.searchParams.get('height') || 0);
    const hasWidth = widthParam > 0;
    const hasHeight = heightParam > 0;
    if (hasWidth && hasHeight && widthParam < 100 && heightParam < 100) return true;

    // 常见空白占位图 URL：t.png、grey.gif、blank.jpg 等
    if (/^(?:t|pixel|blank|spacer|grey|gray)\.(?:png|gif|jpe?g|webp)$/i.test(basename)) return true;

    return false;
  }

  /**
   * 尺寸小于阈值时返回 true。
   * 只有宽高都已知且都小于阈值才判定，避免误伤 1200×80 的商品长条横幅。
   */
  function isBelowMinImageSize(width, height, minSize) {
    const min = Number(minSize) > 0 ? Number(minSize) : 100;
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    return w > 0 && h > 0 && w < min && h < min;
  }

  /** 提取商品 ID（用于测试和调试），找不到时返回空字符串 */
  function extractProductId(rawUrl) {
    try {
      const url = new URL(String(rawUrl));
      for (const key of PRODUCT_ID_KEYS) {
        const value = url.searchParams.get(key);
        if (value && /^\d{5,}$/.test(value.trim())) return value.trim();
      }
      const pathMatch = url.pathname.match(/(?:^|[/_-])(\d{5,})(?:[./_-]|$)/);
      return pathMatch ? pathMatch[1] : '';
    } catch (_error) {
      return '';
    }
  }

  /** 生成商品图_001.png 这样的安全文件名 */
  function buildImageFileName(index, prefix) {
    const safePrefix = typeof prefix === 'string' && prefix.trim() ? prefix.trim() : '商品图';
    const sequence = Math.max(1, Math.floor(Number(index) || 1));
    return `${safePrefix}_${String(sequence).padStart(3, '0')}.png`;
  }

  function formatDimensions(width, height) {
    const w = Math.round(Number(width) || 0);
    const h = Math.round(Number(height) || 0);
    return w > 0 && h > 0 ? `${w} × ${h}` : '尺寸待识别';
  }

  function formatFileSize(bytes) {
    const size = Number(bytes) || 0;
    if (size <= 0) return '未知';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatDuration(milliseconds) {
    const seconds = Math.max(0, Math.round((Number(milliseconds) || 0) / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
  }

  /** 返回图片 origin 对应的 Chrome 匹配模式，例如 https://img.example.com/* */
  function toOriginPattern(rawUrl) {
    try {
      const url = new URL(String(rawUrl));
      if (!/^https?:$/.test(url.protocol)) return null;
      return `${url.protocol}//${url.hostname}/*`;
    } catch (_error) {
      return null;
    }
  }

  function isHttpImageHostCovered(rawUrl) {
    try {
      const url = new URL(String(rawUrl));
      return /^https?:$/.test(url.protocol) && hostMatches(url.hostname, IMAGE_HOST_SUFFIXES);
    } catch (_error) {
      return false;
    }
  }

  /** 找出不在 manifest 固定 host_permissions 内的图片源，画廊会按需申请可选权限 */
  function getUncoveredImageOrigins(rawUrls) {
    const origins = new Set();
    for (const rawUrl of rawUrls || []) {
      if (isHttpImageHostCovered(rawUrl)) continue;
      const pattern = toOriginPattern(rawUrl);
      if (pattern) origins.add(pattern);
    }
    return [...origins];
  }

  return Object.freeze({
    PLATFORM_HOST_SUFFIXES,
    IMAGE_HOST_SUFFIXES,
    IMAGE_ATTRIBUTES,
    SRCSET_ATTRIBUTES,
    hostMatches,
    isSupportedHost,
    getPlatformName,
    getHostLabel,
    hasProductIdentifier,
    isProductDetailUrl,
    extractProductId,
    normalizeImageUrl,
    extractBackgroundUrls,
    parseSrcset,
    pickBestFromSrcset,
    isDecorativeImageUrl,
    isBelowMinImageSize,
    buildImageFileName,
    formatDimensions,
    formatFileSize,
    formatDuration,
    toOriginPattern,
    isHttpImageHostCovered,
    getUncoveredImageOrigins
  });
});
