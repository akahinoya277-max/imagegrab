/**
 * 图提取 ImageGrab - 会话存储
 *
 * 提取结果只在当前浏览器会话中暂存，关闭浏览器后由 Chrome 自动清除。
 * 最多保留 20 份记录，避免长期占用 storage.session 配额。
 */
(function initCaptureStore(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ImageGrabCaptureStore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function createCaptureStore() {
  'use strict';

  const KEY_PREFIX = 'imagegrab:capture:';
  const MAX_CAPTURES = 20;
  const TTL_MS = 24 * 60 * 60 * 1000;

  function storageKey(captureId) {
    return `${KEY_PREFIX}${captureId}`;
  }

  function isCapture(value) {
    return Boolean(
      value &&
      typeof value === 'object' &&
      typeof value.id === 'string' &&
      Array.isArray(value.images) &&
      typeof value.createdAt === 'number'
    );
  }

  function readAll(entries) {
    return Object.entries(entries || {})
      .filter(([key, value]) => key.startsWith(KEY_PREFIX) && isCapture(value))
      .map(([, value]) => value);
  }

  async function cleanup(now = Date.now()) {
    const entries = await chrome.storage.session.get(null);
    const captures = readAll(entries).sort((a, b) => b.createdAt - a.createdAt);
    const expired = new Set();

    captures.forEach((capture, index) => {
      if (now - capture.createdAt > TTL_MS || index >= MAX_CAPTURES) {
        expired.add(storageKey(capture.id));
      }
    });

    if (expired.size > 0) {
      await chrome.storage.session.remove([...expired]);
    }
  }

  async function save(capture) {
    if (!isCapture(capture)) throw new Error('无效的提取记录');
    await cleanup(capture.createdAt).catch(() => {});
    try {
      await chrome.storage.session.set({ [storageKey(capture.id)]: capture });
    } catch (error) {
      throw new Error('浏览器会话存储空间不足，请减少提取图片数量后重试', { cause: error });
    }
    return capture;
  }

  async function get(captureId) {
    if (!captureId || typeof captureId !== 'string') return null;
    const key = storageKey(captureId);
    const entries = await chrome.storage.session.get(key);
    const capture = entries?.[key];
    if (!isCapture(capture)) return null;

    if (Date.now() - capture.createdAt > TTL_MS) {
      await chrome.storage.session.remove(key).catch(() => {});
      return null;
    }
    return capture;
  }

  async function latest() {
    const entries = await chrome.storage.session.get(null);
    const captures = readAll(entries)
      .filter((capture) => Date.now() - capture.createdAt <= TTL_MS)
      .sort((a, b) => b.createdAt - a.createdAt);
    return captures[0] || null;
  }

  return Object.freeze({
    KEY_PREFIX,
    MAX_CAPTURES,
    TTL_MS,
    cleanup,
    save,
    get,
    latest
  });
});
