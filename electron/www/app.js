const DB_NAME = 'MarkyDB';
const DB_VERSION = 1;
const STORE_DOCUMENT = 'document';
const STORE_PREFERENCES = 'preferences';
const DOCUMENT_KEY = 'workspace';
const THEME_KEY = 'theme';
const SPLIT_KEY = 'splitRatio';
const SAVE_DEBOUNCE_MS = 280;
const SPLIT_DEBOUNCE_MS = 120;
const SPLIT_DEFAULT = 50;
const SPLIT_MIN = 20;
const SPLIT_MAX = 80;
const SPLIT_STEP = 2;
const DESKTOP_SPLIT_QUERY = '(min-width: 1024px)';
const DOWNLOAD_FILENAME = 'marky-document.md';

const DEFAULT_MARKDOWN = `# Welcome to Marky

A **fast**, _beautiful_ Markdown editor with live preview.

## Features

- Split-screen editing and preview
- Auto-save on every keystroke
- Light and dark themes
- Export to \`.md\` files

## Try it

1. Edit this text on the left
2. Watch the preview update instantly
3. Toggle the theme in the header

\`\`\`javascript
const greeting = 'Hello, Marky!';
console.log(greeting);
\`\`\`

> Write something great.
`;

const elements = {
  root: document.documentElement,
  editor: document.getElementById('editor'),
  preview: document.getElementById('preview'),
  themeToggle: document.getElementById('theme-toggle'),
  clearBtn: document.getElementById('clear-btn'),
  downloadBtn: document.getElementById('download-btn'),
  downloadBtnMobile: document.getElementById('download-btn-mobile'),
  wordCount: document.getElementById('word-count'),
  charCount: document.getElementById('char-count'),
  wordCountMobile: document.getElementById('word-count-mobile'),
  charCountMobile: document.getElementById('char-count-mobile'),
  saveIndicator: document.getElementById('save-indicator'),
  lastSaved: document.getElementById('last-saved'),
  workspace: document.getElementById('workspace'),
  splitHandle: document.getElementById('split-handle'),
};

let dbPromise = null;
let saveTimer = null;
let saveIndicatorTimer = null;
let splitSaveTimer = null;
let isReady = false;
let splitPercent = SPLIT_DEFAULT;
let isSplitDragging = false;

function openDatabase() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORE_DOCUMENT)) {
        database.createObjectStore(STORE_DOCUMENT);
      }
      if (!database.objectStoreNames.contains(STORE_PREFERENCES)) {
        database.createObjectStore(STORE_PREFERENCES);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

function runTransaction(storeName, mode, operation) {
  return openDatabase().then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);

        const request = operation(store);
        if (request) {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        }
      })
  );
}

function getValue(storeName, key) {
  return runTransaction(storeName, 'readonly', (store) => store.get(key));
}

function putValue(storeName, key, value) {
  return runTransaction(storeName, 'readwrite', (store) => {
    store.put(value, key);
  });
}

function deleteValue(storeName, key) {
  return runTransaction(storeName, 'readwrite', (store) => {
    store.delete(key);
  });
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractCodeArgs(code, infostring) {
  if (code && typeof code === 'object') {
    return {
      text: code.text ?? code.raw ?? '',
      lang: (code.lang ?? code.language ?? infostring ?? '').trim().split(/\s+/)[0],
    };
  }

  return {
    text: String(code ?? ''),
    lang: (infostring ?? '').trim().split(/\s+/)[0],
  };
}

function highlightCode(text, language) {
  const source = String(text ?? '');

  if (typeof hljs === 'undefined') {
    return escapeHtml(source);
  }

  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(source, { language }).value;
  }

  return hljs.highlightAuto(source).value;
}

function renderCodeBlock(code, infostring) {
  const { text, lang } = extractCodeArgs(code, infostring);
  const highlighted = highlightCode(text, lang);
  const langClass = lang ? ` language-${lang}` : '';

  return `<pre class="marky-pre"><code class="hljs${langClass}">${highlighted}</code></pre>`;
}

function configureMarked() {
  if (typeof marked === 'undefined') return;

  const renderer = {
    code: renderCodeBlock,
  };

  if (typeof marked.use === 'function') {
    marked.use({
      gfm: true,
      breaks: true,
      renderer,
    });
    return;
  }

  const baseRenderer = typeof marked.Renderer === 'function' ? new marked.Renderer() : {};
  Object.assign(baseRenderer, renderer);

  marked.setOptions({
    gfm: true,
    breaks: true,
    renderer: baseRenderer,
  });
}

function sanitizeHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = html;

  const forbiddenTags = ['script', 'iframe', 'object', 'embed', 'form', 'button', 'link', 'meta', 'style', 'base'];
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);

  const nodesToProcess = [];
  while (walker.nextNode()) {
    nodesToProcess.push(walker.currentNode);
  }

  nodesToProcess.forEach((node) => {
    const tagName = node.tagName.toLowerCase();

    if (tagName === 'input') {
      const type = (node.getAttribute('type') || '').toLowerCase();
      if (type !== 'checkbox' || !node.hasAttribute('disabled')) {
        node.remove();
      }
      return;
    }

    if (forbiddenTags.includes(tagName)) {
      node.remove();
      return;
    }

    [...node.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();

      if (name.startsWith('on') || (name === 'href' && value.startsWith('javascript:'))) {
        node.removeAttribute(attribute.name);
      }
    });
  });

  return template.innerHTML;
}

function detectCodeLanguage(codeElement) {
  const className = codeElement.className || '';

  const languageMatch = className.match(/(?:^|\s)language-([\w+#.-]+)/i);
  if (languageMatch) return languageMatch[1];

  const hljsMatch = className.match(/(?:^|\s)hljs(?:\s+language-([\w+#.-]+))?/i);
  if (hljsMatch && hljsMatch[1]) return hljsMatch[1];

  return 'plaintext';
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function handleCodeCopy(button, codeElement) {
  const source = codeElement.textContent || '';

  copyTextToClipboard(source)
    .then(() => {
      button.textContent = 'Copied!';
      button.classList.add('is-copied');
      setTimeout(() => {
        button.textContent = 'Copy';
        button.classList.remove('is-copied');
      }, 2000);
    })
    .catch(() => {
      button.textContent = 'Failed';
      setTimeout(() => {
        button.textContent = 'Copy';
      }, 2000);
    });
}

function enhanceCodeBlocks(container) {
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.closest('.marky-code-block')) return;

    const code = pre.querySelector('code');
    if (!code) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'marky-code-block';

    const header = document.createElement('div');
    header.className = 'marky-code-header';

    const label = document.createElement('span');
    label.className = 'marky-code-lang';
    label.textContent = detectCodeLanguage(code);

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'marky-code-copy';
    copyButton.textContent = 'Copy';
    copyButton.setAttribute('aria-label', 'Copy code to clipboard');
    copyButton.addEventListener('click', () => handleCodeCopy(copyButton, code));

    header.append(label, copyButton);
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.append(header, pre);
  });
}

function updateHighlightTheme(theme) {
  const lightTheme = document.getElementById('hljs-theme-light');
  const darkTheme = document.getElementById('hljs-theme-dark');

  if (!lightTheme || !darkTheme) return;

  const isDark = theme === 'dark';
  lightTheme.disabled = isDark;
  darkTheme.disabled = !isDark;
}

function renderPreview(markdown) {
  if (typeof marked === 'undefined') {
    elements.preview.textContent = markdown;
    return;
  }

  const rawHtml = marked.parse(markdown);
  elements.preview.innerHTML = sanitizeHtml(rawHtml);
  enhanceCodeBlocks(elements.preview);
}

function countWords(text) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

function updateStats(text) {
  const words = countWords(text);
  const chars = text.length;

  elements.wordCount.textContent = String(words);
  elements.charCount.textContent = String(chars);
  elements.wordCountMobile.textContent = String(words);
  elements.charCountMobile.textContent = String(chars);
}

function applyTheme(theme) {
  const isDark = theme === 'dark';
  elements.root.classList.toggle('dark', isDark);
  elements.root.style.colorScheme = isDark ? 'dark' : 'light';
  updateHighlightTheme(theme);

  const themeColorMeta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (themeColorMeta) {
    themeColorMeta.content = isDark ? '#020617' : '#f8fafc';
  } else {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = isDark ? '#020617' : '#f8fafc';
    document.head.appendChild(meta);
  }
}

function getActiveTheme() {
  return elements.root.classList.contains('dark') ? 'dark' : 'light';
}

function persistTheme(theme) {
  return putValue(STORE_PREFERENCES, THEME_KEY, theme);
}

function loadTheme() {
  return getValue(STORE_PREFERENCES, THEME_KEY).then((stored) => {
    if (stored === 'dark' || stored === 'light') {
      applyTheme(stored);
      return stored;
    }

    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = prefersDark ? 'dark' : 'light';
    applyTheme(theme);
    return persistTheme(theme).then(() => theme);
  });
}

function toggleTheme() {
  const nextTheme = getActiveTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(nextTheme);
  return persistTheme(nextTheme);
}

function flashSaveIndicator(state) {
  const indicator = elements.saveIndicator;
  indicator.classList.remove('is-saving', 'is-saved');

  if (state === 'saving') {
    indicator.classList.add('is-saving');
  } else if (state === 'saved') {
    indicator.classList.add('is-saved');
  }

  clearTimeout(saveIndicatorTimer);
  if (state) {
    saveIndicatorTimer = setTimeout(() => {
      indicator.classList.remove('is-saving', 'is-saved');
    }, state === 'saving' ? 400 : 1200);
  }
}

function formatSavedTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function persistDocument(text) {
  flashSaveIndicator('saving');

  return putValue(STORE_DOCUMENT, DOCUMENT_KEY, {
    content: text,
    updatedAt: Date.now(),
  }).then(() => {
    flashSaveIndicator('saved');
    elements.lastSaved.textContent = `Saved ${formatSavedTime(new Date())}`;
  });
}

function scheduleSave(text) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    persistDocument(text).catch(handlePersistenceError);
  }, SAVE_DEBOUNCE_MS);
}

function handlePersistenceError() {
  elements.lastSaved.textContent = 'Save unavailable';
  flashSaveIndicator(null);
}

function loadDocument() {
  return getValue(STORE_DOCUMENT, DOCUMENT_KEY).then((record) => {
    if (record && typeof record.content === 'string' && record.content.length > 0) {
      return record.content;
    }
    return DEFAULT_MARKDOWN;
  });
}

function handleInput() {
  const text = elements.editor.value;
  renderPreview(text);
  updateStats(text);

  if (!isReady) return;

  scheduleSave(text);
}

function clearWorkspace() {
  const confirmed = window.confirm('Clear the entire workspace? This cannot be undone.');
  if (!confirmed) return;

  elements.editor.value = '';
  renderPreview('');
  updateStats('');
  flashSaveIndicator('saving');

  deleteValue(STORE_DOCUMENT, DOCUMENT_KEY)
    .then(() => persistDocument(''))
    .then(() => {
      elements.editor.focus();
    })
    .catch(handlePersistenceError);
}

function clampSplit(value) {
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));
}

function isDesktopSplit() {
  return window.matchMedia(DESKTOP_SPLIT_QUERY).matches;
}

function updateSplitAriaOrientation() {
  elements.splitHandle.setAttribute('aria-orientation', isDesktopSplit() ? 'vertical' : 'horizontal');
}

function applySplitGrid() {
  const editorFr = splitPercent;
  const previewFr = 100 - splitPercent;
  const handleTrack = '10px';

  if (isDesktopSplit()) {
    elements.workspace.style.gridTemplateColumns = `minmax(10rem, ${editorFr}fr) ${handleTrack} minmax(10rem, ${previewFr}fr)`;
    elements.workspace.style.gridTemplateRows = 'minmax(0, 1fr)';
  } else {
    elements.workspace.style.gridTemplateColumns = 'minmax(0, 1fr)';
    elements.workspace.style.gridTemplateRows = `minmax(8rem, ${editorFr}fr) ${handleTrack} minmax(8rem, ${previewFr}fr)`;
  }
}

function applySplit(percent) {
  splitPercent = clampSplit(percent);
  applySplitGrid();
  elements.splitHandle.setAttribute('aria-valuenow', String(Math.round(splitPercent)));
}

function scheduleSplitSave() {
  clearTimeout(splitSaveTimer);
  splitSaveTimer = setTimeout(() => {
    putValue(STORE_PREFERENCES, SPLIT_KEY, splitPercent).catch(() => {});
  }, SPLIT_DEBOUNCE_MS);
}

function loadSplit() {
  return getValue(STORE_PREFERENCES, SPLIT_KEY).then((stored) => {
    if (typeof stored === 'number' && stored >= SPLIT_MIN && stored <= SPLIT_MAX) {
      applySplit(stored);
      return;
    }
    applySplit(SPLIT_DEFAULT);
  });
}

function splitPercentFromPointer(clientX, clientY) {
  const rect = elements.workspace.getBoundingClientRect();

  if (isDesktopSplit()) {
    return ((clientX - rect.left) / rect.width) * 100;
  }

  return ((clientY - rect.top) / rect.height) * 100;
}

function onDocumentSplitMove(event) {
  if (!isSplitDragging) return;

  applySplit(splitPercentFromPointer(event.clientX, event.clientY));
  event.preventDefault();
}

function onDocumentSplitEnd(event) {
  if (!isSplitDragging) return;

  isSplitDragging = false;
  elements.workspace.classList.remove('is-resizing');
  document.body.classList.remove('marky-split-active');

  document.removeEventListener('pointermove', onDocumentSplitMove);
  document.removeEventListener('pointerup', onDocumentSplitEnd);
  document.removeEventListener('pointercancel', onDocumentSplitEnd);

  if (elements.splitHandle.hasPointerCapture(event.pointerId)) {
    elements.splitHandle.releasePointerCapture(event.pointerId);
  }

  scheduleSplitSave();
}

function beginSplitDrag(event) {
  if (event.button !== 0) return;

  isSplitDragging = true;
  elements.workspace.classList.add('is-resizing');
  document.body.classList.add('marky-split-active');
  elements.splitHandle.setPointerCapture(event.pointerId);
  applySplit(splitPercentFromPointer(event.clientX, event.clientY));

  document.addEventListener('pointermove', onDocumentSplitMove);
  document.addEventListener('pointerup', onDocumentSplitEnd);
  document.addEventListener('pointercancel', onDocumentSplitEnd);

  event.preventDefault();
}

function adjustSplitByKeyboard(delta) {
  applySplit(splitPercent + delta);
  scheduleSplitSave();
}

function bindSplitEvents() {
  updateSplitAriaOrientation();

  elements.splitHandle.addEventListener('pointerdown', beginSplitDrag);

  elements.splitHandle.addEventListener('dblclick', () => {
    applySplit(SPLIT_DEFAULT);
    scheduleSplitSave();
  });

  elements.splitHandle.addEventListener('keydown', (event) => {
    const vertical = isDesktopSplit();
    const decreaseKeys = vertical ? ['ArrowLeft', 'ArrowUp'] : ['ArrowUp', 'ArrowLeft'];
    const increaseKeys = vertical ? ['ArrowRight', 'ArrowDown'] : ['ArrowDown', 'ArrowRight'];

    if (decreaseKeys.includes(event.key)) {
      event.preventDefault();
      adjustSplitByKeyboard(-SPLIT_STEP);
    } else if (increaseKeys.includes(event.key)) {
      event.preventDefault();
      adjustSplitByKeyboard(SPLIT_STEP);
    } else if (event.key === 'Home') {
      event.preventDefault();
      applySplit(SPLIT_MIN);
      scheduleSplitSave();
    } else if (event.key === 'End') {
      event.preventDefault();
      applySplit(SPLIT_MAX);
      scheduleSplitSave();
    }
  });

  window.matchMedia(DESKTOP_SPLIT_QUERY).addEventListener('change', () => {
    updateSplitAriaOrientation();
    applySplitGrid();
  });

  window.addEventListener('resize', () => {
    if (!isSplitDragging) {
      applySplitGrid();
    }
  });
}

function downloadDocument() {
  const content = elements.editor.value;
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = DOWNLOAD_FILENAME;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();

  requestAnimationFrame(() => {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  });
}

function bindEvents() {
  elements.editor.addEventListener('input', handleInput);

  elements.themeToggle.addEventListener('click', () => {
    toggleTheme().catch(handlePersistenceError);
  });

  elements.clearBtn.addEventListener('click', clearWorkspace);
  elements.downloadBtn.addEventListener('click', downloadDocument);
  elements.downloadBtnMobile.addEventListener('click', downloadDocument);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    getValue(STORE_PREFERENCES, THEME_KEY).then((stored) => {
      if (!stored) {
        applyTheme(event.matches ? 'dark' : 'light');
      }
    });
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .catch(() => {});
  });
}

function initialize() {
  configureMarked();
  bindEvents();
  bindSplitEvents();
  registerServiceWorker();
  applySplit(SPLIT_DEFAULT);

  Promise.all([loadTheme(), loadDocument(), loadSplit()])
    .then(([, content]) => {
      elements.editor.value = content;
      renderPreview(content);
      updateStats(content);
      isReady = true;
      elements.lastSaved.textContent = 'All changes saved';
    })
    .catch(() => {
      elements.editor.value = DEFAULT_MARKDOWN;
      renderPreview(DEFAULT_MARKDOWN);
      updateStats(DEFAULT_MARKDOWN);
      isReady = true;
      elements.lastSaved.textContent = 'Offline mode';
      applyTheme(getActiveTheme());
    });
}

initialize();
