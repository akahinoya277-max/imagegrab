/**
 * 图提取 ImageGrab - 图片下载引擎
 *
 * 在 Service Worker 中完成跨域取图、PNG 转码和落盘。
 * 不依赖 DOM，使用 createImageBitmap + OffscreenCanvas。
 */
(function initImageGrabDownloader(root, factory) {
  root.ImageGrabDownloader = factory();
})(typeof globalThis !== 'undefined' ? globalThis : self, function createDownloader() {
  'use strict';

  const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
  const MAX_PNG_BYTES = 48 * 1024 * 1024;
  const MAX_IMAGE_PIXELS = 60_000_000;
  const DOWNLOAD_TIMEOUT_MS = 120_000;

  class JobError extends Error {
    constructor(code, message, options) {
      super(message, options);
      this.name = 'JobError';
      this.code = code;
    }
  }

  function isAbortError(error, signal) {
    return Boolean(
      signal?.aborted ||
      error?.name === 'AbortError' ||
      (error instanceof JobError && error.code === 'CANCELLED')
    );
  }

  function assertNotAborted(signal) {
    if (signal?.aborted) throw new JobError('CANCELLED', '下载已取消');
  }

  /** 将底层错误转成用户能理解、且不暴露堆栈的中文提示 */
  function getUserErrorMessage(error) {
    if (error instanceof JobError) return error.message;
    if (isAbortError(error)) return '下载已取消';
    if (/Failed to fetch|NetworkError|Load failed/i.test(String(error?.message))) {
      return '无法读取图片，可能是网络异常或图片域名未授权';
    }
    if (/decode|imagebitmap/i.test(String(error?.name || error?.message || ''))) {
      return '图片解码失败，可能是不支持的图片格式';
    }
    if (/quota|storage/i.test(String(error?.message))) {
      return '浏览器存储空间不足，请重新提取后再试';
    }
    return '图片处理失败，请稍后重试';
  }

  function isKnownImageHeader(bytes) {
    if (!bytes || bytes.length < 4) return false;
    const startsWith = (signature) => signature.every((value, index) => bytes[index] === value);

    // PNG
    if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return true;
    // JPEG
    if (startsWith([0xff, 0xd8, 0xff])) return true;
    // GIF
    if (startsWith([0x47, 0x49, 0x46, 0x38])) return true;
    // BMP
    if (startsWith([0x42, 0x4d])) return true;
    // WebP：RIFF....WEBP
    if (
      startsWith([0x52, 0x49, 0x46, 0x46]) &&
      bytes.length >= 12 &&
      [0x57, 0x45, 0x42, 0x50].every((value, index) => bytes[8 + index] === value)
    ) return true;
    // AVIF / HEIC / HEIF：ftyp 位于第 4 字节
    if (bytes.length >= 12 && [0x66, 0x74, 0x79, 0x70].every((value, index) => bytes[4 + index] === value)) {
      const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
      if (['avif', 'avis', 'heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) return true;
    }
    // SVG / XML 图片（是否可解码交给 createImageBitmap 判断）
    if (bytes[0] === 0x3c) return true;
    return false;
  }

  function httpError(status) {
    if (status === 401 || status === 403) {
      return new JobError('HTTP_FORBIDDEN', '图片服务器拒绝访问（HTTP ' + status + '）');
    }
    if (status === 404 || status === 410) {
      return new JobError('HTTP_NOT_FOUND', '图片已失效（HTTP ' + status + '）');
    }
    if (status === 429) {
      return new JobError('HTTP_RATE_LIMIT', '图片服务器请求过于频繁（HTTP 429）');
    }
    return new JobError('HTTP_ERROR', '图片加载失败（HTTP ' + status + '）');
  }

  /**
   * 读取跨域图片。
   * 固定 host_permissions 已覆盖主流电商 CDN；其他域名由画廊尝试申请可选权限。
   */
  async function fetchImageBlob(url, signal) {
    assertNotAborted(signal);
    if (!/^https?:\/\//i.test(String(url))) {
      throw new JobError('INVALID_URL', '图片地址无效');
    }

    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        credentials: 'omit',
        cache: 'force-cache',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
        signal
      });
    } catch (error) {
      if (isAbortError(error, signal)) throw new JobError('CANCELLED', '下载已取消');
      throw new JobError('FETCH_FAILED', '无法读取图片，可能是网络异常或图片域名未授权', { cause: error });
    }

    if (!response.ok) throw httpError(response.status);

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_SOURCE_BYTES) {
      throw new JobError('SOURCE_TOO_LARGE', '原图超过 32 MB，暂不支持转换');
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html') || contentType.includes('application/json')) {
      throw new JobError('NOT_IMAGE', '图片地址返回的不是图片，可能已过期');
    }

    let blob;
    try {
      blob = await response.blob();
    } catch (error) {
      if (isAbortError(error, signal)) throw new JobError('CANCELLED', '下载已取消');
      throw new JobError('READ_FAILED', '读取图片数据失败', { cause: error });
    }

    if (!blob || blob.size === 0) throw new JobError('EMPTY_IMAGE', '图片内容为空');
    if (blob.size > MAX_SOURCE_BYTES) {
      throw new JobError('SOURCE_TOO_LARGE', '原图超过 32 MB，暂不支持转换');
    }

    let headerBytes;
    try {
      headerBytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    } catch (_error) {
      headerBytes = new Uint8Array(0);
    }
    if (!isKnownImageHeader(headerBytes) && !contentType.startsWith('image/')) {
      throw new JobError('NOT_IMAGE', '图片地址返回的内容无法识别');
    }

    return blob;
  }

  /** 使用 OffscreenCanvas 把任意浏览器可解码图片统一绘制并导出为 PNG */
  async function convertBlobToPng(blob) {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
      throw new JobError('UNSUPPORTED_BROWSER', '当前 Chrome 版本不支持 PNG 转码，请升级浏览器');
    }

    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (error) {
      throw new JobError('DECODE_FAILED', '图片解码失败，可能是不支持或已损坏的图片格式', { cause: error });
    }

    try {
      const width = Number(bitmap.width) || 0;
      const height = Number(bitmap.height) || 0;
      if (!width || !height) throw new JobError('DECODE_FAILED', '图片尺寸无效');
      if (width < 100 && height < 100) {
        throw new JobError('IMAGE_TOO_SMALL', '图片尺寸小于 100 × 100，已自动跳过');
      }
      if (width * height > MAX_IMAGE_PIXELS) {
        throw new JobError('IMAGE_TOO_LARGE', '图片像素过大，浏览器无法完成 PNG 转换');
      }

      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', { alpha: true });
      if (!context) throw new JobError('CANVAS_FAILED', '无法创建图片画布');

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0);

      let pngBlob;
      try {
        pngBlob = await canvas.convertToBlob({ type: 'image/png' });
      } catch (error) {
        throw new JobError('ENCODE_FAILED', 'PNG 编码失败，图片可能过大', { cause: error });
      }

      if (!pngBlob || pngBlob.size === 0) throw new JobError('ENCODE_FAILED', 'PNG 编码结果为空');
      if (pngBlob.size > MAX_PNG_BYTES) {
        throw new JobError('PNG_TOO_LARGE', '转换后的 PNG 超过 48 MB，暂不支持保存');
      }
      return pngBlob;
    } finally {
      if (typeof bitmap.close === 'function') bitmap.close();
    }
  }

  /** Service Worker 没有 FileReader，使用分块 btoa 生成 data URL 供 downloads API 使用 */
  async function blobToPngDataUrl(blob) {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const chunks = [];
    const chunkSize = 0x8000;

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
    }

    let base64;
    try {
      base64 = btoa(chunks.join(''));
    } catch (error) {
      throw new JobError('ENCODE_FAILED', 'PNG 数据编码失败', { cause: error });
    }
    return 'data:image/png;base64,' + base64;
  }

  function mapDownloadError(code) {
    const messages = {
      USER_CANCELED: '下载被取消',
      FILE_ACCESS_DENIED: '浏览器无法写入默认下载目录',
      FILE_NO_SPACE: '下载目录空间不足',
      FILE_NAME_TOO_LONG: '文件名过长，无法保存',
      NETWORK_FAILED: '保存文件时网络中断',
      SERVER_FAILED: '下载服务异常',
      CRASH: '浏览器下载进程异常'
    };
    return new JobError('DOWNLOAD_FAILED', messages[code] || '浏览器未能保存图片（' + code + '）');
  }

  /**
   * 触发 chrome.downloads.download，并等待真实落盘完成。
   * 使用 onChanged + 定时查询双保险，兼容事件早于 downloadId 返回的极快下载。
   */
  function downloadDataUrl(dataUrl, filename, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new JobError('CANCELLED', '下载已取消'));
        return;
      }

      let settled = false;
      let downloadId = null;
      let pollTimer = 0;
      let timeoutTimer = 0;

      const onAbort = () => {
        if (settled) return;
        const idAtAbort = downloadId;
        finishError(new JobError('CANCELLED', '下载已取消'));
        if (idAtAbort) {
          chrome.downloads.cancel(idAtAbort, () => {
            // 读取 lastError 避免控制台出现未检查错误。
            void chrome.runtime.lastError;
          });
        }
      };

      const cleanup = () => {
        if (pollTimer) clearInterval(pollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        pollTimer = 0;
        timeoutTimer = 0;
        chrome.downloads.onChanged.removeListener(onChanged);
        signal?.removeEventListener('abort', onAbort);
      };

      const finishSuccess = (item) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          downloadId,
          filename: item?.filename || filename,
          fileSize: Number(item?.fileSize) || 0
        });
      };

      const finishError = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const inspect = () => {
        if (settled || !downloadId) return;
        chrome.downloads.search({ id: downloadId }, (items) => {
          if (chrome.runtime.lastError || settled) return;
          const item = items?.[0];
          if (!item) return;
          if (item.state === 'complete') finishSuccess(item);
          if (item.state === 'interrupted') finishError(mapDownloadError(item.error));
        });
      };

      const onChanged = (delta) => {
        if (settled || !downloadId || delta.id !== downloadId) return;
        const state = delta.state?.current;
        if (state === 'complete') inspect();
        if (state === 'interrupted') inspect();
      };

      chrome.downloads.onChanged.addListener(onChanged);
      signal?.addEventListener('abort', onAbort, { once: true });

      timeoutTimer = setTimeout(() => {
        if (settled) return;
        if (downloadId) {
          chrome.downloads.cancel(downloadId, () => {
            void chrome.runtime.lastError;
          });
        }
        finishError(new JobError('DOWNLOAD_TIMEOUT', '保存图片超时，请重试'));
      }, DOWNLOAD_TIMEOUT_MS);

      try {
        chrome.downloads.download(
          {
            url: dataUrl,
            filename,
            conflictAction: 'uniquify',
            saveAs: false
          },
          (id) => {
            if (settled) {
              if (id) {
                chrome.downloads.cancel(id, () => {
                  void chrome.runtime.lastError;
                });
              }
              return;
            }
            if (chrome.runtime.lastError || !id) {
              finishError(new JobError(
                'DOWNLOAD_FAILED',
                '浏览器未能创建下载任务：' + (chrome.runtime.lastError?.message || '未知错误')
              ));
              return;
            }

            downloadId = id;
            pollTimer = setInterval(inspect, 1000);
            inspect();
          }
        );
      } catch (error) {
        finishError(new JobError('DOWNLOAD_FAILED', '浏览器未能发起下载', { cause: error }));
      }
    });
  }

  /**
   * 单张图片完整处理流程：取图 → 转 PNG → 生成 data URL → 保存。
   * onPhase 用于把阶段变化推送到画廊。
   */
  async function processAndDownload(url, filename, signal, onPhase) {
    assertNotAborted(signal);
    onPhase?.('fetch');

    const sourceBlob = await fetchImageBlob(url, signal);
    assertNotAborted(signal);
    onPhase?.('convert');

    const pngBlob = await convertBlobToPng(sourceBlob);
    assertNotAborted(signal);
    onPhase?.('encode');

    const dataUrl = await blobToPngDataUrl(pngBlob);
    assertNotAborted(signal);
    onPhase?.('save');

    const download = await downloadDataUrl(dataUrl, filename, signal);
    return {
      ...download,
      pngBytes: pngBlob.size
    };
  }

  return Object.freeze({
    JobError,
    isAbortError,
    getUserErrorMessage,
    fetchImageBlob,
    convertBlobToPng,
    blobToPngDataUrl,
    downloadDataUrl,
    processAndDownload,
    MAX_SOURCE_BYTES,
    MAX_PNG_BYTES
  });
});
