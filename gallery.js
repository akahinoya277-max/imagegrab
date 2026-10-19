(function initImageGrabGallery() {
  'use strict';

  const Core = globalThis.ImageGrabCore;
  const DOWNLOAD_PORT = 'imagegrab-download';
  const MIN_IMAGE_SIZE = 100;
  const LOAD_TIMEOUT_MS = 12000;

  if (!Core) {
    document.body.textContent = '图提取：共享脚本加载失败，请重新加载扩展。';
    return;
  }

  const state = {
    capture: null,
    images: [],
    selected: new Set(),
    cards: new Map(),
    loadToken: 0,
    previewIndex: -1,
    toastTimer: 0,
    permissionPending: false,
    downloading: false,
    finished: false,
    cancelRequested: false,
    jobStarted: false,
    port: null,
    startTimer: 0,
    cancelTimer: 0,
    warnedTiny: false
  };

  const els = {};
  const byId = (id) => document.getElementById(id);

  function cacheElements() {
    const ids = [
      'loadingState', 'emptyState', 'errorState', 'errorMessage', 'imageGrid',
      'toolbar', 'selectedCount', 'totalCount', 'downloadButton', 'downloadBadge',
      'selectAllButton', 'invertSelectionButton', 'reloadButton', 'retryButton',
      'pageTitle', 'sourceLine', 'platformChip', 'platformLabel', 'openSourceButton',
      'heroImageCount', 'imageCardTemplate', 'previewDialog', 'previewTitle',
      'previewImage', 'previewDimensions', 'closePreviewButton',
      'openPreviewOriginalButton', 'previousImageButton', 'nextImageButton',
      'downloadDialog', 'downloadIcon', 'downloadEyebrow', 'downloadTitle',
      'downloadSubtitle', 'downloadProgressArea', 'downloadProgressLabel',
      'downloadProgressCount', 'downloadProgressbar', 'downloadProgressFill',
      'currentFile', 'currentFilename', 'currentPhase', 'downloadResults',
      'successCount', 'failureCount', 'durationText', 'failureList',
      'openFolderButton', 'cancelDownloadButton', 'closeDownloadButton', 'toast'
    ];

    for (const id of ids) els[id] = byId(id);
    els.downloadShell = document.querySelector('.download-shell');
    els.previewStage = document.querySelector('.preview-stage');

    const missing = Object.entries(els).filter(([, node]) => !node).map(([key]) => key);
    if (missing.length > 0) {
      console.error('[图提取] 画廊元素缺失：', missing);
      return false;
    }
    return true;
  }

  /** 将后台记录中的图片再做一次轻量清洗，避免异常 URL 进入 DOM */
  function normalizeCapturedImage(raw, index, pageUrl) {
    if (!raw || typeof raw.url !== 'string') return null;
    const url = Core.normalizeImageUrl(raw.url, pageUrl);
    if (!url) return null;

    const width = Math.max(0, Math.round(Number(raw.width) || 0));
    const height = Math.max(0, Math.round(Number(raw.height) || 0));
    return {
      url,
      width,
      height,
      alt: String(raw.alt || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      source: String(raw.source || 'unknown').slice(0, 32),
      order: index,
      tooSmall: Core.isBelowMinImageSize(width, height, MIN_IMAGE_SIZE),
      previewError: false
    };
  }

  function formatDate(timestamp) {
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(timestamp));
    } catch (_error) {
      return '刚刚';
    }
  }

  function getPlatformLabel(page) {
    if (String(page?.host || '').toLowerCase() === 'mms.pinduoduo.com') return '拼多多商家版';
    return Core.getPlatformName(page?.url || '') || page?.platform || '商品平台';
  }

  function getDisplayTitle(image, index) {
    const alt = String(image.alt || '').trim();
    return alt || `商品图片 ${String(index + 1).padStart(2, '0')}`;
  }

  function withTimeout(promise, milliseconds) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('读取图片记录超时，请重试。')), milliseconds);
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  function setView(view) {
    els.loadingState.hidden = view !== 'loading';
    els.emptyState.hidden = view !== 'empty';
    els.errorState.hidden = view !== 'error';
    els.toolbar.hidden = view !== 'gallery';
    els.imageGrid.hidden = view !== 'gallery';
    document.body.dataset.view = view;
  }

  function resetGalleryState() {
    state.capture = null;
    state.images = [];
    state.selected.clear();
    state.cards.clear();
    state.warnedTiny = false;
    els.imageGrid.replaceChildren();
    els.loadingState.hidden = false;
    els.emptyState.hidden = true;
    els.errorState.hidden = true;
    els.toolbar.hidden = true;
    els.imageGrid.hidden = true;
  }

  function setHeaderPlaceholder() {
    els.pageTitle.textContent = '正在读取图片…';
    els.sourceLine.textContent = '请稍候，正在准备商品图片。';
    els.platformChip.hidden = true;
    els.openSourceButton.hidden = true;
    els.heroImageCount.textContent = '—';
  }

  function renderHeader() {
    const page = state.capture?.page || {};
    const title = String(page.title || '商品详情图片').trim() || '商品详情图片';
    const platform = getPlatformLabel(page);
    const host = String(page.host || Core.getHostLabel(page.url) || '').replace(/^www\./, '');

    els.pageTitle.textContent = title;
    els.pageTitle.title = title;
    els.sourceLine.textContent = [platform, host, `${formatDate(state.capture?.createdAt)} 提取`]
      .filter(Boolean)
      .join(' · ');
    els.platformLabel.textContent = platform;
    els.platformChip.hidden = false;
    els.heroImageCount.textContent = String(state.images.length);
    els.totalCount.textContent = String(state.images.length);

    let sourceUrl = '';
    try {
      const parsed = new URL(page.url);
      if (/^https?:$/.test(parsed.protocol)) sourceUrl = parsed.href;
    } catch (_error) {
      sourceUrl = '';
    }
    els.openSourceButton.hidden = !sourceUrl;
    els.openSourceButton.dataset.sourceUrl = sourceUrl;
    document.title = `${title} - 图提取 ImageGrab`;
  }

  function showEmpty(message) {
    state.capture = null;
    state.images = [];
    state.selected.clear();
    state.cards.clear();
    els.imageGrid.replaceChildren();
    els.pageTitle.textContent = '还没有可展示的图片';
    els.sourceLine.textContent = message || '在商品详情页点击「获取图片」后，画廊会自动出现在新标签页。';
    els.platformChip.hidden = true;
    els.openSourceButton.hidden = true;
    els.heroImageCount.textContent = '0';
    els.totalCount.textContent = '0';
    els.selectedCount.textContent = '0';
    els.downloadBadge.hidden = true;
    setView('empty');
    document.title = '还没有图片 - 图提取 ImageGrab';
  }

  function showError(message) {
    state.capture = null;
    state.images = [];
    state.selected.clear();
    state.cards.clear();
    els.imageGrid.replaceChildren();
    els.pageTitle.textContent = '无法读取图片';
    els.sourceLine.textContent = '图片列表可能已过期，请回到商品页重新提取。';
    els.platformChip.hidden = true;
    els.openSourceButton.hidden = true;
    els.heroImageCount.textContent = '—';
    els.errorMessage.textContent = message || '请确认扩展已正确加载，然后重试。';
    setView('error');
    document.title = '读取失败 - 图提取 ImageGrab';
  }

  async function loadCapture() {
    if (state.downloading) {
      showToast('请等待当前下载完成后再刷新画廊。');
      return;
    }

    const token = ++state.loadToken;
    state.capture = null;
    state.images = [];
    state.selected.clear();
    state.cards.clear();
    state.previewIndex = -1;
    els.imageGrid.replaceChildren();
    els.toolbar.hidden = true;
    els.imageGrid.hidden = true;
    els.emptyState.hidden = true;
    els.errorState.hidden = true;
    els.loadingState.hidden = false;
    setHeaderPlaceholder();

    const captureId = new URL(location.href).searchParams.get('capture') || '';
    let response;
    try {
      const message = { type: 'IMAGEGRAB_GET_CAPTURE' };
      if (captureId) message.captureId = captureId;
      response = await withTimeout(chrome.runtime.sendMessage(message), LOAD_TIMEOUT_MS);
    } catch (error) {
      if (token !== state.loadToken) return;
      console.error('[图提取] 读取记录失败：', error);
      showError(error?.message || '无法连接扩展后台，请重新加载扩展后再试。');
      return;
    }

    if (token !== state.loadToken) return;
    if (!response?.ok) {
      if (!captureId) showEmpty();
      else showError(response?.error || '提取记录不存在或已过期。');
      return;
    }

    const capture = response.capture;
    const pageUrl = capture?.page?.url || location.href;
    const images = [];
    const seen = new Set();
    for (const raw of Array.isArray(capture?.images) ? capture.images : []) {
      const image = normalizeCapturedImage(raw, images.length, pageUrl);
      if (!image || seen.has(image.url)) continue;
      seen.add(image.url);
      images.push(image);
    }

    if (images.length === 0) {
      showEmpty('这次提取没有留下可用的图片，请回到商品页重新提取。');
      return;
    }

    state.capture = capture;
    state.images = images;
    renderHeader();
    renderGallery();
  }

  function updateImageDimension(image, entry) {
    entry.sizeEl.textContent = Core.formatDimensions(image.width, image.height);
  }

  function markImageTooSmall(image, entry) {
    const newlyMarked = !image.tooSmall;
    image.tooSmall = true;
    state.selected.delete(image.url);
    entry.card.classList.add('is-unavailable');
    entry.checkbox.disabled = true;
    entry.checkbox.checked = false;
    entry.statusBadge.hidden = false;
    entry.statusBadge.className = 'status-badge is-warning';
    entry.statusBadge.textContent = '尺寸过小';
    updateImageDimension(image, entry);
    updateSelectionUI();

    if (newlyMarked && !state.warnedTiny) {
      state.warnedTiny = true;
      showToast('已自动排除小于 100 × 100 的图片。');
    }
  }

  function markImageTooSmallIfNeeded(image, entry) {
    if (Core.isBelowMinImageSize(image.width, image.height, MIN_IMAGE_SIZE)) {
      markImageTooSmall(image, entry);
    }
  }

  function updateSelectionUI() {
    const selectable = state.images.filter((image) => !image.tooSmall);
    const count = state.selected.size;
    const busy = state.downloading || state.permissionPending;

    els.selectedCount.textContent = String(count);
    els.totalCount.textContent = String(state.images.length);
    els.downloadBadge.hidden = count === 0;
    els.downloadBadge.textContent = String(count);
    els.downloadButton.disabled = busy || count === 0;
    els.downloadButton.setAttribute('aria-label', `下载选中的 ${count} 张图片为 PNG`);

    const allSelected = selectable.length > 0 && count === selectable.length;
    els.selectAllButton.disabled = busy || selectable.length === 0 || allSelected;
    els.invertSelectionButton.disabled = busy || selectable.length === 0;

    let sequence = 0;
    for (const image of state.images) {
      const entry = state.cards.get(image.url);
      if (!entry) continue;

      const isSelected = state.selected.has(image.url);
      entry.checkbox.checked = isSelected;
      entry.checkbox.disabled = busy || image.tooSmall;
      entry.card.classList.toggle('is-selected', isSelected);

      if (image.tooSmall) {
        entry.filenameEl.textContent = '尺寸不足 · 已排除';
      } else if (isSelected) {
        sequence += 1;
        entry.filenameEl.textContent = Core.buildImageFileName(sequence, '商品图');
      } else {
        entry.filenameEl.textContent = 'PNG · 未选择';
      }
    }
  }

  function applyTooSmallOnLoad(image, entry) {
    if (image.width && image.height && !entry.checkbox.disabled) {
      updateImageDimension(image, entry);
    }
    if (image.tooSmall) return;
    if (Core.isBelowMinImageSize(image.width, image.height, MIN_IMAGE_SIZE)) {
      markImageTooSmall(image, entry);
    }
  }

  function createCard(image, index) {
    const card = els.imageCardTemplate.content.firstElementChild.cloneNode(true);
    const checkbox = card.querySelector('.image-checkbox');
    const previewButton = card.querySelector('.preview-button');
    const imageEl = card.querySelector('.preview-canvas img');
    const sizeEl = card.querySelector('.image-size');
    const filenameEl = card.querySelector('.filename');
    const statusBadge = card.querySelector('.status-badge');
    const titleEl = card.querySelector('.card-title');
    const orderEl = card.querySelector('.image-order');
    const displayTitle = getDisplayTitle(image, index);

    card.dataset.index = String(index);
    orderEl.textContent = String(index + 1).padStart(2, '0');
    titleEl.textContent = displayTitle;
    titleEl.title = displayTitle;
    imageEl.alt = displayTitle;
    previewButton.setAttribute('aria-label', `预览第 ${index + 1} 张商品图片`);
    checkbox.setAttribute('aria-label', `选择${displayTitle}`);
    sizeEl.textContent = Core.formatDimensions(image.width, image.height);

    const entry = { card, checkbox, previewButton, imageEl, sizeEl, filenameEl, statusBadge, titleEl };
    state.cards.set(image.url, entry);

    if (image.tooSmall) {
      card.classList.add('is-unavailable');
      checkbox.disabled = true;
      statusBadge.hidden = false;
      statusBadge.className = 'status-badge is-warning';
      statusBadge.textContent = '尺寸过小';
    } else {
      state.selected.add(image.url);
    }

    checkbox.addEventListener('change', () => {
      if (checkbox.disabled) return;
      if (checkbox.checked) state.selected.add(image.url);
      else state.selected.delete(image.url);
      updateSelectionUI();
    });

    previewButton.addEventListener('click', () => openPreview(index));

    imageEl.addEventListener('load', () => {
      image.width = imageEl.naturalWidth || image.width;
      image.height = imageEl.naturalHeight || image.height;
      image.previewError = false;
      card.classList.remove('has-preview-error');
      updateImageDimension(image, entry);
      applyTooSmallOnLoad(image, entry);
    });

    imageEl.addEventListener('error', () => {
      image.previewError = true;
      card.classList.add('has-preview-error');
      previewButton.title = '缩略图预览失败，下载时仍会重试';
    });

    imageEl.src = image.url;
    return card;
  }

  function renderGallery() {
    const fragment = document.createDocumentFragment();
    state.selected.clear();
    state.cards.clear();

    state.images.forEach((image, index) => {
      fragment.appendChild(createCard(image, index));
    });

    els.imageGrid.replaceChildren(fragment);
    setView('gallery');
    updateSelectionUI();
  }

  function selectAllImages() {
    for (const image of state.images) {
      if (!image.tooSmall) state.selected.add(image.url);
    }
    updateSelectionUI();
  }

  function invertSelection() {
    for (const image of state.images) {
      if (image.tooSmall) continue;
      if (state.selected.has(image.url)) state.selected.delete(image.url);
      else state.selected.add(image.url);
    }
    updateSelectionUI();
  }

  function openPreview(index) {
    if (!state.images[index]) return;
    state.previewIndex = index;
    updatePreview();
    if (!els.previewDialog.open) els.previewDialog.showModal();
  }

  function updatePreview() {
    const image = state.images[state.previewIndex];
    if (!image) return;
    const displayTitle = getDisplayTitle(image, state.previewIndex);

    els.previewTitle.textContent = displayTitle;
    els.previewImage.alt = displayTitle;
    els.previewStage.classList.remove('has-error');
    els.previewImage.src = image.url;
    els.previewDimensions.textContent = Core.formatDimensions(image.width, image.height);
    els.previousImageButton.disabled = state.images.length <= 1;
    els.nextImageButton.disabled = state.images.length <= 1;
  }

  function movePreview(step) {
    if (state.images.length === 0) return;
    state.previewIndex = (state.previewIndex + step + state.images.length) % state.images.length;
    updatePreview();
  }

  function closePreview() {
    if (els.previewDialog.open) els.previewDialog.close();
  }

  function openSourcePage() {
    const sourceUrl = els.openSourceButton.dataset.sourceUrl;
    if (!sourceUrl) return;
    chrome.tabs.create({ url: sourceUrl, active: true }).catch(() => {
      showToast('无法打开原商品页，请回到原标签页查看。', 'error');
    });
  }

  function openOriginalImage() {
    const image = state.images[state.previewIndex];
    if (!image) return;
    chrome.tabs.create({ url: image.url, active: true }).catch(() => {
      showToast('无法打开原图，请稍后重试。', 'error');
    });
  }

  function showToast(message, kind = 'info') {
    window.clearTimeout(state.toastTimer);
    els.toast.textContent = message;
    els.toast.className = `toast${kind === 'error' ? ' is-error' : kind === 'success' ? ' is-success' : ''}`;
    els.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => {
      els.toast.hidden = true;
    }, 3600);
  }

  function reloadGallery() {
    // 清掉失效的 capture 参数，再读取最近一次记录。
    try {
      history.replaceState(null, '', location.pathname);
    } catch (_error) {
      // file:// 或特殊环境不允许 replaceState 时忽略。
    }
    loadCapture();
  }

  function bindPreviewEvents() {
    els.closePreviewButton.addEventListener('click', closePreview);
    els.previousImageButton.addEventListener('click', () => movePreview(-1));
    els.nextImageButton.addEventListener('click', () => movePreview(1));
    els.openPreviewOriginalButton.addEventListener('click', openOriginalImage);

    els.previewDialog.addEventListener('click', (event) => {
      if (event.target === els.previewDialog) closePreview();
    });

    els.previewDialog.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') movePreview(-1);
      if (event.key === 'ArrowRight') movePreview(1);
    });

    els.previewImage.addEventListener('load', () => {
      els.previewStage.classList.remove('has-error');
      if (els.previewImage.naturalWidth && els.previewImage.naturalHeight) {
        els.previewDimensions.textContent =
          `${els.previewImage.naturalWidth} × ${els.previewImage.naturalHeight}`;
      }
    });

    els.previewImage.addEventListener('error', () => {
      els.previewStage.classList.add('has-error');
      els.previewDimensions.textContent = '预览加载失败，仍可尝试下载';
    });
  }

  const PHASE_LABELS = {
    fetch: '正在读取原图…',
    convert: '正在转换为 PNG…',
    encode: '正在编码 PNG…',
    save: '正在保存到下载目录…',
    'item-complete': '已完成，继续下一张…',
    cancelled: '正在取消…'
  };

  function clearJobTimers() {
    window.clearTimeout(state.startTimer);
    window.clearTimeout(state.cancelTimer);
    state.startTimer = 0;
    state.cancelTimer = 0;
  }

  function disconnectPort() {
    const port = state.port;
    state.port = null;
    if (!port) return;
    try {
      port.disconnect();
    } catch (_error) {
      // 端口已断开时无需再次处理。
    }
  }

  function resetCardDownloadStatus(urls) {
    for (const url of urls) {
      const entry = state.cards.get(url);
      if (!entry) continue;
      entry.card.classList.remove('is-downloaded', 'is-failed');
      if (!entry.checkbox.disabled) {
        entry.statusBadge.hidden = true;
        entry.statusBadge.className = 'status-badge';
        entry.statusBadge.textContent = '';
      }
    }
  }

  /** 只对不在 manifest 固定 host_permissions 内的图片域名申请可选权限 */
  function requestOptionalHostPermissions(urls) {
    const origins = Core.getUncoveredImageOrigins(urls);
    if (origins.length === 0) {
      return Promise.resolve({ requested: false, granted: true, count: 0 });
    }
    if (!chrome.permissions?.request) {
      return Promise.resolve({ requested: false, granted: false, count: origins.length });
    }

    return new Promise((resolve) => {
      try {
        chrome.permissions.request({ origins }, (granted) => {
          const error = chrome.runtime.lastError;
          if (error) {
            console.warn('[图提取] 可选图片域名权限申请失败：', error.message);
            resolve({ requested: true, granted: false, count: origins.length });
            return;
          }
          resolve({ requested: true, granted: Boolean(granted), count: origins.length });
        });
      } catch (error) {
        console.warn('[图提取] 可选权限请求异常：', error);
        resolve({ requested: true, granted: false, count: origins.length });
      }
    });
  }

  async function handleDownloadClick() {
    if (state.downloading || state.permissionPending || !state.capture) return;

    const urls = state.images
      .filter((image) => state.selected.has(image.url) && !image.tooSmall)
      .map((image) => image.url);

    if (urls.length === 0) {
      showToast('请至少勾选一张图片。', 'error');
      return;
    }

    state.permissionPending = true;
    updateSelectionUI();

    // Chrome 要求可选权限必须在用户点击的调用栈中申请；这里不要先 await 其他异步操作。
    const permission = await requestOptionalHostPermissions(urls);
    state.permissionPending = false;

    if (permission.requested && !permission.granted) {
      showToast('部分图片域名未获得授权，仍会尝试下载；失败项会单独提示。');
    }

    startDownloadJob(urls);
  }

  function openDownloadDialog(total) {
    els.downloadShell.classList.remove('is-success', 'is-error', 'is-cancelled');
    els.downloadEyebrow.textContent = '正在处理';
    els.downloadTitle.textContent = '正在准备下载';
    els.downloadSubtitle.textContent = '正在连接本地下载服务，所有转换都在本机完成。';
    els.downloadProgressArea.hidden = false;
    els.downloadProgressArea.classList.add('is-indeterminate');
    els.downloadProgressLabel.textContent = '正在准备…';
    els.downloadProgressCount.textContent = `0 / ${total}`;
    els.downloadProgressFill.style.width = '0%';
    els.downloadProgressbar.removeAttribute('aria-valuenow');
    els.downloadProgressbar.setAttribute('aria-valuetext', '正在准备下载');
    els.currentFile.hidden = true;
    els.downloadResults.hidden = true;
    els.failureList.hidden = true;
    els.failureList.replaceChildren();
    els.successCount.textContent = '0';
    els.failureCount.textContent = '0';
    els.durationText.textContent = '0 秒';
    els.cancelDownloadButton.hidden = false;
    els.cancelDownloadButton.disabled = false;
    els.cancelDownloadButton.textContent = '取消';
    els.closeDownloadButton.hidden = true;
    els.openFolderButton.hidden = true;
    els.downloadDialog.setAttribute('aria-busy', 'true');

    if (!els.downloadDialog.open) els.downloadDialog.showModal();
  }

  function startDownloadJob(urls) {
    state.downloading = true;
    state.finished = false;
    state.cancelRequested = false;
    state.jobStarted = false;
    state.activeTotal = urls.length;
    resetCardDownloadStatus(urls);
    openDownloadDialog(urls.length);
    updateSelectionUI();

    let port;
    try {
      port = chrome.runtime.connect({ name: DOWNLOAD_PORT });
    } catch (error) {
      failDownload('无法连接扩展后台，请刷新画廊后重试。');
      return;
    }

    state.port = port;
    port.onMessage.addListener((message) => handleDownloadMessage(message));
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (state.downloading && !state.finished) {
        failDownload('下载服务连接已断开，请关闭此窗口后重试。');
      }
    });

    state.startTimer = window.setTimeout(() => {
      if (state.downloading && !state.finished && !state.jobStarted) {
        failDownload('下载服务响应超时，请关闭此窗口后重试。');
      }
    }, 15000);

    try {
      port.postMessage({
        type: 'START_DOWNLOADS',
        captureId: state.capture.id,
        urls
      });
    } catch (error) {
      failDownload('无法发起下载任务，请刷新画廊后重试。');
    }
  }

  function setProgressBar(completed, total) {
    const safeTotal = Math.max(1, Number(total) || 0);
    const safeCompleted = Math.min(safeTotal, Math.max(0, Number(completed) || 0));
    const percent = Math.round((safeCompleted / safeTotal) * 100);
    els.downloadProgressArea.classList.remove('is-indeterminate');
    els.downloadProgressFill.style.width = `${percent}%`;
    els.downloadProgressbar.setAttribute('aria-valuemin', '0');
    els.downloadProgressbar.setAttribute('aria-valuemax', String(safeTotal));
    els.downloadProgressbar.setAttribute('aria-valuenow', String(safeCompleted));
    els.downloadProgressbar.setAttribute('aria-valuetext', `已处理 ${safeCompleted} / ${safeTotal} 张`);
    els.downloadProgressCount.textContent = `${safeCompleted} / ${safeTotal}`;
  }

  function updateDownloadProgress(message) {
    state.jobStarted = true;
    window.clearTimeout(state.startTimer);
    const total = Math.max(0, Number(message.total) || state.activeTotal || 0);
    const completed = Math.max(0, Number(message.completed) || 0);
    state.activeTotal = total;
    setProgressBar(completed, total);

    const index = Math.max(1, Number(message.currentIndex) || completed + 1);
    els.downloadProgressLabel.textContent =
      message.phase === 'item-complete'
        ? `已处理 ${completed} / ${total} 张`
        : `正在处理第 ${Math.min(index, total)} / ${total} 张`;
    els.currentFile.hidden = false;
    els.currentFilename.textContent = message.filename || '商品图.png';
    els.currentPhase.textContent = PHASE_LABELS[message.phase] || '正在处理…';
    els.downloadTitle.textContent = '正在转换为 PNG';
    els.downloadSubtitle.textContent = '请保持此页面打开，完成后会自动给出结果。';
  }

  function markCardDownloadResult(result) {
    if (!result || !result.url) return;
    const entry = state.cards.get(result.url);
    if (!entry) return;
    entry.statusBadge.hidden = false;

    if (result.ok) {
      entry.card.classList.add('is-downloaded');
      entry.card.classList.remove('is-failed');
      entry.statusBadge.className = 'status-badge is-success';
      entry.statusBadge.textContent = '已保存';
      entry.statusBadge.title = result.filename || '已保存为 PNG';
    } else {
      entry.card.classList.add('is-failed');
      entry.card.classList.remove('is-downloaded');
      entry.statusBadge.className = 'status-badge is-error';
      entry.statusBadge.textContent = '下载失败';
      entry.statusBadge.title = result.error || '下载失败';
    }
  }

  function handleDownloadMessage(message) {
    if (!message || typeof message.type !== 'string' || state.finished) return;

    try {
      if (message.type === 'STARTED') {
        state.jobStarted = true;
        window.clearTimeout(state.startTimer);
        state.activeTotal = Math.max(0, Number(message.total) || state.activeTotal || 0);
        setProgressBar(0, state.activeTotal);
        els.downloadProgressLabel.textContent = '开始处理…';
        return;
      }

      if (message.type === 'PROGRESS') {
        updateDownloadProgress(message);
        return;
      }

      if (message.type === 'ITEM_DONE') {
        state.jobStarted = true;
        window.clearTimeout(state.startTimer);
        markCardDownloadResult(message.result);
        return;
      }

      if (message.type === 'DONE') {
        finishDownload(message);
        return;
      }

      if (message.type === 'ERROR') {
        failDownload(message.error || '下载任务未能完成，请重试。');
      }
    } catch (error) {
      console.error('[图提取] 画廊处理进度失败：', error);
      failDownload('页面处理下载进度时出错，请刷新后重试。');
    }
  }

  function renderFailureList(results) {
    const failures = results.filter((result) => !result.ok);
    els.failureList.replaceChildren();
    els.failureList.hidden = failures.length === 0;

    for (const failure of failures) {
      const item = document.createElement('div');
      item.className = 'failure-item';
      const name = document.createElement('strong');
      const reason = document.createElement('span');
      name.textContent = String(failure.filename || '商品图.png').replace(/^.*[\\/]/, '');
      reason.textContent = failure.error || '未知错误';
      item.append(name, reason);
      els.failureList.appendChild(item);
    }
  }

  function finishDownload(message) {
    if (state.finished) return;
    state.finished = true;
    state.downloading = false;
    state.cancelRequested = false;
    state.jobStarted = true;
    clearJobTimers();

    const results = Array.isArray(message.results) ? message.results : [];
    for (const result of results) markCardDownloadResult(result);

    const total = Math.max(1, Number(message.total) || state.activeTotal || results.length || 1);
    const completed = Math.max(0, Number(message.completed) || results.length);
    const succeeded = Math.max(0, Number(message.succeeded) || 0);
    const failed = Math.max(0, Number(message.failed) || 0);
    const cancelled = Boolean(message.cancelled);

    setProgressBar(completed, total);
    els.downloadProgressLabel.textContent = cancelled ? '下载已取消' : '全部处理完成';
    els.currentFile.hidden = true;
    els.downloadProgressArea.classList.remove('is-indeterminate');
    els.downloadProgressArea.hidden = false;
    els.downloadResults.hidden = false;
    els.successCount.textContent = String(succeeded);
    els.failureCount.textContent = String(failed);
    els.durationText.textContent = Core.formatDuration(message.durationMs).replace(' ', ' ');
    renderFailureList(results);

    if (cancelled) {
      els.downloadShell.classList.add('is-cancelled');
      els.downloadEyebrow.textContent = '已取消';
      els.downloadTitle.textContent = '下载已取消';
      els.downloadSubtitle.textContent = succeeded > 0
        ? `已完成的 ${succeeded} 张图片会保留在下载目录。`
        : '没有图片被保存，你可以重新选择后再下载。';
    } else if (failed === 0) {
      els.downloadShell.classList.add('is-success');
      els.downloadEyebrow.textContent = '下载完成';
      els.downloadTitle.textContent = '全部下载完成';
      els.downloadSubtitle.textContent = `${succeeded} 张图片已统一转为 PNG 保存到默认下载目录。`;
    } else if (succeeded === 0) {
      els.downloadShell.classList.add('is-error');
      els.downloadEyebrow.textContent = '下载失败';
      els.downloadTitle.textContent = '图片未能保存';
      els.downloadSubtitle.textContent = '请查看下方失败原因，或检查图片域名权限后重试。';
    } else {
      els.downloadShell.classList.add('is-error');
      els.downloadEyebrow.textContent = '部分完成';
      els.downloadTitle.textContent = '下载完成，部分图片失败';
      els.downloadSubtitle.textContent = `成功 ${succeeded} 张，失败 ${failed} 张。失败原因见下方。`;
    }

    els.downloadDialog.setAttribute('aria-busy', 'false');
    els.cancelDownloadButton.hidden = true;
    els.cancelDownloadButton.disabled = false;
    els.cancelDownloadButton.textContent = '取消';
    els.closeDownloadButton.hidden = false;
    els.openFolderButton.hidden = succeeded === 0;
    updateSelectionUI();
    disconnectPort();
    window.setTimeout(() => els.closeDownloadButton.focus(), 30);

    if (cancelled) showToast('下载已取消，已保存的图片会保留。');
    else if (failed > 0) showToast(`下载完成：成功 ${succeeded} 张，失败 ${failed} 张。`, 'error');
    else showToast(`已成功下载 ${succeeded} 张 PNG 图片。`, 'success');
  }

  function failDownload(message) {
    if (state.finished && !state.downloading) return;
    state.finished = true;
    state.downloading = false;
    state.cancelRequested = false;
    clearJobTimers();

    els.downloadShell.classList.remove('is-success', 'is-cancelled');
    els.downloadShell.classList.add('is-error');
    els.downloadEyebrow.textContent = '下载中断';
    els.downloadTitle.textContent = '下载没有完成';
    els.downloadSubtitle.textContent = message || '请检查网络或图片权限后重试。';
    els.downloadProgressArea.hidden = true;
    els.downloadResults.hidden = true;
    els.downloadDialog.setAttribute('aria-busy', 'false');
    els.cancelDownloadButton.hidden = true;
    els.closeDownloadButton.hidden = false;
    els.openFolderButton.hidden = true;
    updateSelectionUI();
    disconnectPort();
    window.setTimeout(() => els.closeDownloadButton.focus(), 30);
    showToast(message || '下载失败，请重试。', 'error');
  }

  function requestCancelDownload() {
    if (!state.downloading || state.cancelRequested) return;
    state.cancelRequested = true;
    els.cancelDownloadButton.disabled = true;
    els.cancelDownloadButton.textContent = '正在取消…';
    els.downloadTitle.textContent = '正在取消下载';
    els.downloadSubtitle.textContent = '正在停止当前任务，已经保存的图片不会删除。';
    els.downloadProgressLabel.textContent = '等待当前图片处理结束后取消…';

    try {
      state.port?.postMessage({ type: 'CANCEL' });
    } catch (error) {
      failDownload('取消请求发送失败，请关闭此窗口后重试。');
      return;
    }

    window.clearTimeout(state.cancelTimer);
    state.cancelTimer = window.setTimeout(() => {
      if (state.downloading && !state.finished) {
        failDownload('取消操作超时，请关闭此窗口后重试。');
      }
    }, 15000);
  }

  function closeDownloadDialog() {
    if (state.downloading) {
      showToast('下载仍在进行，请点击「取消」停止任务。');
      return;
    }
    if (els.downloadDialog.open) els.downloadDialog.close();
  }

  function openDownloadFolder() {
    try {
      chrome.downloads.showDefaultFolder();
    } catch (error) {
      showToast('无法打开下载文件夹，请在浏览器下载记录中查看。', 'error');
    }
  }

  function bindStaticEvents() {
    els.selectAllButton.addEventListener('click', selectAllImages);
    els.invertSelectionButton.addEventListener('click', invertSelection);
    els.downloadButton.addEventListener('click', () => { void handleDownloadClick(); });
    els.reloadButton.addEventListener('click', reloadGallery);
    els.retryButton.addEventListener('click', reloadGallery);
    els.openSourceButton.addEventListener('click', openSourcePage);
    els.cancelDownloadButton.addEventListener('click', requestCancelDownload);
    els.closeDownloadButton.addEventListener('click', closeDownloadDialog);
    els.openFolderButton.addEventListener('click', openDownloadFolder);

    els.downloadDialog.addEventListener('cancel', (event) => {
      if (state.downloading) {
        event.preventDefault();
        showToast('下载仍在进行，请等待完成或点击「取消」。');
      }
    });

    els.downloadDialog.addEventListener('click', (event) => {
      if (event.target === els.downloadDialog && !state.downloading) closeDownloadDialog();
    });

    bindPreviewEvents();

    window.addEventListener('beforeunload', (event) => {
      if (!state.downloading) return;
      event.preventDefault();
      event.returnValue = '';
    });

    window.addEventListener('pagehide', () => {
      if (state.port) {
        state.finished = true;
        disconnectPort();
      }
    });
  }

  let booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    if (!cacheElements()) {
      document.body.textContent = '图提取画廊加载失败，请重新加载扩展。';
      return;
    }
    bindStaticEvents();
    setView('loading');
    void loadCapture();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
