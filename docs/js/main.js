/**
 * 图提取 ImageGrab 官网交互
 * 无依赖、无构建，直接由 index.html 加载。
 */
(function initSite() {
  'use strict';

  const header = document.getElementById('siteHeader');
  const nav = document.getElementById('siteNav');
  const menuToggle = document.getElementById('menuToggle');
  const navLinks = [...document.querySelectorAll('.nav-link')];
  const sectionLinks = navLinks.filter((link) => link.getAttribute('href')?.startsWith('#'));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------- 顶部导航：滚动阴影 ---------- */
  let scrollTicking = false;
  function onScroll() {
    if (scrollTicking) return;
    scrollTicking = true;

    window.requestAnimationFrame(() => {
      header.classList.toggle('is-scrolled', window.scrollY > 12);
      updateActiveNav();
      scrollTicking = false;
    });
  }

  /* ---------- 当前区块高亮 ---------- */
  const observedSections = sectionLinks
    .map((link) => {
      const selector = link.getAttribute('href');
      const section = selector && selector.length > 1 ? document.querySelector(selector) : null;
      return section ? { link, section } : null;
    })
    .filter(Boolean);

  function updateActiveNav() {
    const threshold = window.innerHeight * 0.34;
    let active = null;

    for (const item of observedSections) {
      const rect = item.section.getBoundingClientRect();
      if (rect.top <= threshold) active = item;
    }

    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    if (atBottom && observedSections.length > 0) {
      active = observedSections[observedSections.length - 1];
    }

    for (const item of observedSections) {
      item.link.classList.toggle('is-active', Boolean(active && item.link === active.link));
      if (active && item.link === active.link) item.link.setAttribute('aria-current', 'location');
      else item.link.removeAttribute('aria-current');
    }
  }

  /* ---------- 移动端菜单 ---------- */
  function isMenuOpen() {
    return menuToggle.getAttribute('aria-expanded') === 'true';
  }

  function openMenu() {
    nav.classList.add('is-open');
    menuToggle.setAttribute('aria-expanded', 'true');
    menuToggle.setAttribute('aria-label', '关闭导航菜单');
    header.classList.add('menu-open');
  }

  function closeMenu(restoreFocus = false) {
    nav.classList.remove('is-open');
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', '打开导航菜单');
    header.classList.remove('menu-open');
    if (restoreFocus) menuToggle.focus();
  }

  menuToggle.addEventListener('click', () => {
    if (isMenuOpen()) closeMenu();
    else openMenu();
  });

  for (const link of navLinks) {
    link.addEventListener('click', () => {
      if (isMenuOpen()) closeMenu();
    });
  }

  document.addEventListener('click', (event) => {
    if (!isMenuOpen()) return;
    if (nav.contains(event.target) || menuToggle.contains(event.target)) return;
    closeMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isMenuOpen()) closeMenu(true);
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 900 && isMenuOpen()) closeMenu();
    updateActiveNav();
  }, { passive: true });

  /* ---------- 滚动进入视口动画 ---------- */
  const revealElements = [...document.querySelectorAll('.reveal')];
  if ('IntersectionObserver' in window && !reduceMotion.matches) {
    const revealObserver = new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

    for (const element of revealElements) revealObserver.observe(element);
  } else {
    for (const element of revealElements) element.classList.add('is-visible');
  }

  /* ---------- 安装命令复制 ---------- */
  const toast = document.getElementById('toast');
  let toastTimer = 0;

  function showToast(message) {
    if (!toast) return;
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('is-visible');
    toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2600);
  }

  function copyText(text) {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(text);
    }

    return new Promise((resolve, reject) => {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        const successful = document.execCommand('copy');
        textarea.remove();
        if (successful) resolve();
        else reject(new Error('execCommand copy failed'));
      } catch (error) {
        textarea.remove();
        reject(error);
      }
    });
  }

  const copyButton = document.getElementById('copyExtensions');
  copyButton?.addEventListener('click', async () => {
    const value = copyButton.dataset.copy || 'chrome://extensions';
    try {
      await copyText(value);
      copyButton.classList.add('is-copied');
      showToast('地址已复制，粘贴到 Chrome 地址栏即可。');
      window.setTimeout(() => copyButton.classList.remove('is-copied'), 1800);
    } catch (_error) {
      showToast('复制失败，请手动选择地址复制。');
    }
  });

  /* ---------- 年份与初始化 ---------- */
  const yearNode = document.getElementById('currentYear');
  if (yearNode) yearNode.textContent = String(new Date().getFullYear());

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  updateActiveNav();

  // 键盘从导航跳转后把焦点交给目标区块，避免焦点留在已收起的菜单中。
  for (const link of sectionLinks) {
    link.addEventListener('click', () => {
      const target = document.querySelector(link.getAttribute('href'));
      if (!target) return;
      window.setTimeout(() => {
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }, 320);
    });
  }
})();
