import {
  hasDiskAccess,
  pickMarkdownFile,
  pickMarkdownFolder,
  pickUploadFilesElectron,
  ingestUploadedFiles,
  loadFileContent,
  saveFileToDisk,
} from './filesystem.js';

const DB_NAME = 'MarkyDB';
const DB_VERSION = 1;
const STORE_DOCUMENT = 'document';
const STORE_PREFERENCES = 'preferences';
const DOCUMENT_KEY = 'workspace';
const THEME_KEY = 'theme';
const SPLIT_LAYOUT_KEY = 'splitLayout';
const SAVE_DEBOUNCE_MS = 280;
const DISK_SAVE_DEBOUNCE_MS = 400;
const SPLIT_DEBOUNCE_MS = 120;
const SPLIT_STEP = 2;
const MIN_PANEL_PCT = 15;
const HANDLE_PX = 10;
const DESKTOP_LAYOUT_QUERY = '(min-width: 1024px)';
const DOWNLOAD_FILENAME = 'marky-document.md';

const LAYOUT_DEFAULT = { tree: 30, source: 35, preview: 35 };

const DEFAULT_MARKDOWN = `# Welcome to Marky

A **fast**, _beautiful_ Markdown editor with live preview.

## Features

- Split-screen editing and preview
- Open files and folders from disk
- Save changes back to your markdown files
- Auto-save on every keystroke
- Light and dark themes

## Try it

1. Click **Folder** or **File** in the toolbar
2. Select a markdown file from the tree
3. Edit and press **Save** or \`Ctrl+S\`

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
  fsMenuBtn: document.getElementById('fs-menu-btn'),
  fsMenuPanel: document.getElementById('fs-menu-panel'),
  uploadFilesInput: document.getElementById('upload-files-input'),
  saveFileBtn: document.getElementById('save-file-btn'),
  wordCount: document.getElementById('word-count'),
  charCount: document.getElementById('char-count'),
  wordCountMobile: document.getElementById('word-count-mobile'),
  charCountMobile: document.getElementById('char-count-mobile'),
  saveIndicator: document.getElementById('save-indicator'),
  lastSaved: document.getElementById('last-saved'),
  footerMode: document.getElementById('footer-mode'),
  workspace: document.getElementById('workspace'),
  splitHandleTree: document.getElementById('split-handle-tree'),
  splitHandleEditor: document.getElementById('split-handle-editor'),
  fileTree: document.getElementById('file-tree'),
  fileTreeEmpty: document.getElementById('file-tree-empty'),
  workspaceRoot: document.getElementById('workspace-root'),
  activeFileLabel: document.getElementById('active-file-label'),
  workspaceTabs: document.getElementById('workspace-tabs'),
};

const fileState = {
  mode: null,
  rootName: '',
  rootHandle: null,
  rootPath: null,
  tree: [],
  openFiles: new Map(),
  activePath: null,
};

let dbPromise = null;
let saveTimer = null;
let diskSaveTimer = null;
let saveIndicatorTimer = null;
let splitSaveTimer = null;
let isReady = false;
let layout = { ...LAYOUT_DEFAULT };
let activeSplitHandle = null;
let isSplitDragging = false;
let editorDirty = false;
let savedSnapshot = '';

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

function updateFooterStatus(message) {
  elements.lastSaved.textContent = message;
}

function updateSaveButtonState() {
  const canSave = Boolean(fileState.activePath);
  elements.saveFileBtn.disabled = !canSave;
}

function updateActiveFileUi() {
  const name = fileState.activePath ? fileState.activePath.split('/').pop() : '';
  elements.activeFileLabel.textContent = editorDirty && name ? `${name} •` : name;
  elements.workspaceRoot.textContent = fileState.rootName || '';
  elements.workspaceRoot.title = fileState.rootPath || fileState.rootName || '';

  if (fileState.activePath) {
    elements.footerMode.innerHTML = `Editing <strong class="font-medium text-slate-500 dark:text-slate-400">${escapeHtml(name)}</strong>`;
  } else {
    elements.footerMode.innerHTML = 'Auto-saved to <strong class="font-medium text-slate-500 dark:text-slate-400">MarkyDB</strong>';
  }

  updateSaveButtonState();
}

function persistDocument(text) {
  flashSaveIndicator('saving');

  return putValue(STORE_DOCUMENT, DOCUMENT_KEY, {
    content: text,
    updatedAt: Date.now(),
  }).then(() => {
    flashSaveIndicator('saved');
    if (!fileState.activePath) {
      updateFooterStatus(`Saved ${formatSavedTime(new Date())}`);
    }
  });
}

function scheduleSave(text) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    persistDocument(text).catch(handlePersistenceError);
  }, SAVE_DEBOUNCE_MS);
}

function scheduleDiskSave() {
  if (!fileState.activePath) return;

  clearTimeout(diskSaveTimer);
  diskSaveTimer = setTimeout(() => {
    saveToDisk().catch(() => {
      updateFooterStatus('Disk save failed');
    });
  }, DISK_SAVE_DEBOUNCE_MS);
}

function handlePersistenceError() {
  if (!fileState.activePath) {
    updateFooterStatus('Save unavailable');
  }
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

function setEditorContent(text, options = {}) {
  const { markSaved = true, render = true } = options;
  elements.editor.value = text;
  savedSnapshot = text;
  editorDirty = false;

  if (render) {
    renderPreview(text);
    updateStats(text);
  }

  updateActiveFileUi();
}

function markEditorDirty() {
  const text = elements.editor.value;
  editorDirty = text !== savedSnapshot;

  if (fileState.activePath) {
    const entry = fileState.openFiles.get(fileState.activePath);
    if (entry) {
      entry.dirty = editorDirty;
      entry.content = text;
    }
    renderFileTree();
  }

  updateActiveFileUi();
}

function handleInput() {
  const text = elements.editor.value;
  renderPreview(text);
  updateStats(text);
  markEditorDirty();

  if (!isReady) return;

  scheduleSave(text);
  scheduleDiskSave();
}

async function confirmDiscardChanges() {
  if (!editorDirty) return true;
  return window.confirm('Discard unsaved changes?');
}

async function saveToDisk() {
  if (!fileState.activePath) {
    window.alert('Open a markdown file to save to disk.');
    return;
  }

  const text = elements.editor.value;
  const entry = fileState.openFiles.get(fileState.activePath);

  if (!entry) {
    window.alert('Unable to resolve the active file.');
    return;
  }

  flashSaveIndicator('saving');
  entry.content = text;

  const previousPath = fileState.activePath;

  await saveFileToDisk(entry, text, fileState);

  if (entry.path !== previousPath) {
    fileState.openFiles.delete(previousPath);
    fileState.openFiles.set(entry.path, entry);
    fileState.activePath = entry.path;
    updateTreeFilePath(previousPath, entry.path, entry.name);
  }

  savedSnapshot = text;
  editorDirty = false;
  entry.dirty = false;

  flashSaveIndicator('saved');
  updateFooterStatus(`Saved to disk ${formatSavedTime(new Date())}`);
  renderFileTree();
  updateActiveFileUi();
}

async function selectTreeFile(node) {
  if (node.type !== 'file') return;

  if (fileState.activePath === node.path) return;

  const canContinue = await confirmDiscardChanges();
  if (!canContinue) return;

  let fileEntry = fileState.openFiles.get(node.path);

  if (!fileEntry) {
    fileEntry = await loadFileContent(node, fileState);
  }

  fileState.openFiles.set(node.path, fileEntry);

  fileState.activePath = node.path;
  setEditorContent(fileEntry.content);
  renderFileTree();
  elements.editor.focus();
  setMobilePanel('editor');
}

function toggleFolder(node, listItem) {
  node.expanded = !node.expanded;
  const childList = listItem.querySelector(':scope > .marky-tree-children');
  if (childList) {
    childList.hidden = !node.expanded;
  }
  const chevron = listItem.querySelector(':scope > .marky-tree-row .marky-tree-chevron');
  if (chevron) {
    chevron.classList.toggle('is-expanded', node.expanded);
  }
}

function createTreeRow(node) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'marky-tree-row';
  row.title = node.path;

  if (node.type === 'directory') {
    row.classList.add('marky-tree-folder');
    row.innerHTML = `<span class="marky-tree-chevron${node.expanded ? ' is-expanded' : ''}" aria-hidden="true"></span><span class="marky-tree-icon marky-tree-icon-folder" aria-hidden="true"></span><span class="marky-tree-name">${escapeHtml(node.name)}</span>`;
    return row;
  }

  row.classList.add('marky-tree-file');
  if (node.path === fileState.activePath) {
    row.classList.add('is-active');
  }

  const entry = fileState.openFiles.get(node.path);
  if (entry?.dirty) {
    row.classList.add('is-dirty');
  }

  row.innerHTML = `<span class="marky-tree-chevron marky-tree-chevron-placeholder" aria-hidden="true"></span><span class="marky-tree-icon marky-tree-icon-file" aria-hidden="true"></span><span class="marky-tree-name">${escapeHtml(node.name)}</span>`;
  row.addEventListener('click', () => selectTreeFile(node));
  return row;
}

function renderTreeNode(node) {
  const item = document.createElement('li');
  item.className = 'marky-tree-item';

  const row = createTreeRow(node);
  item.appendChild(row);

  if (node.type === 'directory' && node.children?.length) {
    const childList = document.createElement('ul');
    childList.className = 'marky-tree-children';
    childList.hidden = !node.expanded;
    node.children.forEach((child) => childList.appendChild(renderTreeNode(child)));
    item.appendChild(childList);

    row.addEventListener('click', () => toggleFolder(node, item));
  }

  return item;
}

function renderFileTree() {
  elements.fileTree.innerHTML = '';

  if (!fileState.tree.length) {
    elements.fileTreeEmpty.classList.remove('hidden');
    return;
  }

  elements.fileTreeEmpty.classList.add('hidden');

  const list = document.createElement('ul');
  list.className = 'marky-tree-root';
  fileState.tree.forEach((node) => list.appendChild(renderTreeNode(node)));
  elements.fileTree.appendChild(list);
}

function populateOpenFiles(context) {
  const map = new Map();

  if (context.files?.length) {
    context.files.forEach((file) => map.set(file.path, file));
  }

  if (context.file) {
    map.set(context.file.path, context.file);
  }

  return map;
}

function applyWorkspaceContext(context) {
  fileState.mode = context.mode;
  fileState.rootName = context.rootName || '';
  fileState.rootHandle = context.rootHandle || null;
  fileState.rootPath = context.rootPath || null;
  fileState.tree = context.tree || [];
  fileState.openFiles = populateOpenFiles(context);

  if (context.file) {
    fileState.activePath = context.file.path;
    setEditorContent(context.file.content);
  } else if (context.firstPath && fileState.openFiles.has(context.firstPath)) {
    fileState.activePath = context.firstPath;
    setEditorContent(fileState.openFiles.get(context.firstPath).content);
  } else {
    fileState.activePath = null;
  }

  renderFileTree();
  updateActiveFileUi();
}

async function applyUploadContext(context) {
  applyWorkspaceContext(context);
  setMobilePanel('tree');
  elements.editor.focus();
}

function updateTreeFilePath(oldPath, newPath, newName) {
  const visit = (nodes) => {
    nodes.forEach((node) => {
      if (node.type === 'file' && node.path === oldPath) {
        node.path = newPath;
        node.name = newName;
      }
      if (node.children?.length) visit(node.children);
    });
  };
  visit(fileState.tree);
}

async function handleUploadFiles(fileList) {
  if (!fileList?.length) return;

  try {
    const canContinue = await confirmDiscardChanges();
    if (!canContinue) return;

    const context = await ingestUploadedFiles(fileList);
    await applyUploadContext(context);
  } catch (error) {
    if (error?.message !== 'No markdown files selected') {
      window.alert('Could not load the uploaded files.');
    }
  }
}

async function handleUploadClick() {
  try {
    const electronContext = await pickUploadFilesElectron();
    if (electronContext) {
      const canContinue = await confirmDiscardChanges();
      if (!canContinue) return;
      await applyUploadContext(electronContext);
      return;
    }
  } catch (error) {
    if (error?.name !== 'AbortError') {
      window.alert('Could not upload files.');
    }
    return;
  }

  elements.uploadFilesInput.click();
}

function handleUploadInputChange(event) {
  const fileList = event.target.files;
  handleUploadFiles(fileList).finally(() => {
    event.target.value = '';
  });
}

async function handleOpenFile() {
  if (!hasDiskAccess()) {
    window.alert('Your browser does not support opening files from disk. Use Chrome, Edge, or the Marky desktop app.');
    return;
  }

  try {
    const canContinue = await confirmDiscardChanges();
    if (!canContinue) return;

    const context = await pickMarkdownFile();
    if (!context) return;

    applyWorkspaceContext(context);

    if (context.file) {
      setMobilePanel('editor');
      elements.editor.focus();
    }
  } catch (error) {
    if (error?.name !== 'AbortError') {
      window.alert('Could not open the file.');
    }
  }
}

async function handleOpenFolder() {
  if (!hasDiskAccess()) {
    window.alert('Your browser does not support opening folders from disk. Use Chrome, Edge, or the Marky desktop app.');
    return;
  }

  try {
    const canContinue = await confirmDiscardChanges();
    if (!canContinue) return;

    const context = await pickMarkdownFolder();
    if (!context) return;

    applyWorkspaceContext(context);
    setMobilePanel('tree');

    if (fileState.tree.length === 1 && fileState.tree[0].type === 'file') {
      await selectTreeFile(fileState.tree[0]);
    }
  } catch (error) {
    if (error?.name !== 'AbortError') {
      window.alert('Could not open the folder.');
    }
  }
}

function clearWorkspace() {
  const confirmed = window.confirm('Clear the entire workspace? This cannot be undone.');
  if (!confirmed) return;

  fileState.mode = null;
  fileState.rootName = '';
  fileState.rootHandle = null;
  fileState.rootPath = null;
  fileState.tree = [];
  fileState.openFiles = new Map();
  fileState.activePath = null;

  setEditorContent('');
  renderFileTree();
  flashSaveIndicator('saving');

  deleteValue(STORE_DOCUMENT, DOCUMENT_KEY)
    .then(() => persistDocument(''))
    .then(() => {
      elements.editor.focus();
    })
    .catch(handlePersistenceError);
}

function normalizeLayout() {
  const sum = layout.tree + layout.source + layout.preview;
  if (sum <= 0) {
    layout = { ...LAYOUT_DEFAULT };
    return;
  }

  layout.tree = (layout.tree / sum) * 100;
  layout.source = (layout.source / sum) * 100;
  layout.preview = (layout.preview / sum) * 100;

  layout.tree = Math.max(MIN_PANEL_PCT, layout.tree);
  layout.source = Math.max(MIN_PANEL_PCT, layout.source);
  layout.preview = Math.max(MIN_PANEL_PCT, layout.preview);

  const total = layout.tree + layout.source + layout.preview;
  layout.tree = (layout.tree / total) * 100;
  layout.source = (layout.source / total) * 100;
  layout.preview = (layout.preview / total) * 100;
}

function isDesktopLayout() {
  return window.matchMedia(DESKTOP_LAYOUT_QUERY).matches;
}

function applyLayoutGrid() {
  normalizeLayout();

  const treeFr = layout.tree;
  const sourceFr = layout.source;
  const previewFr = layout.preview;
  const handleTrack = `${HANDLE_PX}px`;

  if (isDesktopLayout()) {
    elements.workspace.style.gridTemplateColumns = `minmax(8rem, ${treeFr}fr) ${handleTrack} minmax(8rem, ${sourceFr}fr) ${handleTrack} minmax(8rem, ${previewFr}fr)`;
    elements.workspace.style.gridTemplateRows = 'minmax(0, 1fr)';
  } else {
    elements.workspace.style.gridTemplateColumns = 'minmax(0, 1fr)';
    elements.workspace.style.gridTemplateRows = '';
  }
}

function applyLayout(nextLayout) {
  layout = { ...nextLayout };
  applyLayoutGrid();
}

function scheduleLayoutSave() {
  clearTimeout(splitSaveTimer);
  splitSaveTimer = setTimeout(() => {
    putValue(STORE_PREFERENCES, SPLIT_LAYOUT_KEY, layout).catch(() => {});
  }, SPLIT_DEBOUNCE_MS);
}

function loadLayout() {
  return getValue(STORE_PREFERENCES, SPLIT_LAYOUT_KEY).then((stored) => {
    if (stored && typeof stored.tree === 'number' && typeof stored.source === 'number' && typeof stored.preview === 'number') {
      applyLayout(stored);
      return;
    }
    applyLayout(LAYOUT_DEFAULT);
  });
}

function getWorkspaceMetrics() {
  const rect = elements.workspace.getBoundingClientRect();
  const available = rect.width - HANDLE_PX * 2;
  return { rect, available };
}

function layoutFromTreeSplit(clientX) {
  const { rect, available } = getWorkspaceMetrics();
  const treePx = Math.min(Math.max(clientX - rect.left - HANDLE_PX / 2, available * (MIN_PANEL_PCT / 100)), available * (1 - (MIN_PANEL_PCT * 2) / 100));
  const restPx = available - treePx;
  const sourceShare = layout.source / (layout.source + layout.preview);
  const sourcePx = restPx * sourceShare;
  const previewPx = restPx - sourcePx;

  return {
    tree: (treePx / available) * 100,
    source: (sourcePx / available) * 100,
    preview: (previewPx / available) * 100,
  };
}

function layoutFromEditorSplit(clientX) {
  const { rect, available } = getWorkspaceMetrics();
  const treePx = (layout.tree / 100) * available;
  const pointerPx = clientX - rect.left - treePx - HANDLE_PX * 1.5;
  const restPx = available - treePx;
  const sourcePx = Math.min(Math.max(pointerPx, restPx * (MIN_PANEL_PCT / 100)), restPx * (1 - MIN_PANEL_PCT / 100));
  const previewPx = restPx - sourcePx;

  return {
    tree: layout.tree,
    source: (sourcePx / available) * 100,
    preview: (previewPx / available) * 100,
  };
}

function onDocumentSplitMove(event) {
  if (!isSplitDragging || !activeSplitHandle) return;

  if (activeSplitHandle === 'tree') {
    applyLayout(layoutFromTreeSplit(event.clientX));
  } else {
    applyLayout(layoutFromEditorSplit(event.clientX));
  }

  event.preventDefault();
}

function onDocumentSplitEnd(event) {
  if (!isSplitDragging) return;

  isSplitDragging = false;
  activeSplitHandle = null;
  elements.workspace.classList.remove('is-resizing');
  document.body.classList.remove('marky-split-active');

  document.removeEventListener('pointermove', onDocumentSplitMove);
  document.removeEventListener('pointerup', onDocumentSplitEnd);
  document.removeEventListener('pointercancel', onDocumentSplitEnd);

  const handleEl = event.target.closest?.('.marky-split-handle');
  if (handleEl?.hasPointerCapture?.(event.pointerId)) {
    handleEl.releasePointerCapture(event.pointerId);
  }

  scheduleLayoutSave();
}

function beginSplitDrag(handleName, event) {
  if (event.button !== 0 || !isDesktopLayout()) return;

  isSplitDragging = true;
  activeSplitHandle = handleName;
  elements.workspace.classList.add('is-resizing');
  document.body.classList.add('marky-split-active');
  event.currentTarget.setPointerCapture(event.pointerId);

  if (handleName === 'tree') {
    applyLayout(layoutFromTreeSplit(event.clientX));
  } else {
    applyLayout(layoutFromEditorSplit(event.clientX));
  }

  document.addEventListener('pointermove', onDocumentSplitMove);
  document.addEventListener('pointerup', onDocumentSplitEnd);
  document.addEventListener('pointercancel', onDocumentSplitEnd);

  event.preventDefault();
}

function bindSplitEvents() {
  elements.splitHandleTree.addEventListener('pointerdown', (event) => beginSplitDrag('tree', event));
  elements.splitHandleEditor.addEventListener('pointerdown', (event) => beginSplitDrag('editor', event));

  elements.splitHandleTree.addEventListener('dblclick', () => {
    applyLayout(LAYOUT_DEFAULT);
    scheduleLayoutSave();
  });

  elements.splitHandleEditor.addEventListener('dblclick', () => {
    applyLayout({ tree: layout.tree, source: 35, preview: 35 });
    normalizeLayout();
    applyLayoutGrid();
    scheduleLayoutSave();
  });

  window.matchMedia(DESKTOP_LAYOUT_QUERY).addEventListener('change', applyLayoutGrid);
  window.addEventListener('resize', () => {
    if (!isSplitDragging) applyLayoutGrid();
  });
}

function setMobilePanel(panelName) {
  elements.workspace.dataset.mobilePanel = panelName;

  if (!elements.workspaceTabs) return;

  elements.workspaceTabs.querySelectorAll('.marky-tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.panel === panelName);
  });
}

function bindMobileTabs() {
  if (!elements.workspaceTabs) return;

  elements.workspaceTabs.querySelectorAll('.marky-tab').forEach((tab) => {
    tab.addEventListener('click', () => setMobilePanel(tab.dataset.panel));
  });
}

function downloadDocument() {
  const content = elements.editor.value;
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const filename = fileState.activePath ? fileState.activePath.split('/').pop() : DOWNLOAD_FILENAME;

  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();

  requestAnimationFrame(() => {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  });
}

function setFsMenuOpen(isOpen) {
  elements.fsMenuPanel.hidden = !isOpen;
  elements.fsMenuBtn.setAttribute('aria-expanded', String(isOpen));
  elements.fsMenuBtn.classList.toggle('is-open', isOpen);
}

function closeFsMenu() {
  setFsMenuOpen(false);
}

function toggleFsMenu() {
  setFsMenuOpen(elements.fsMenuPanel.hidden);
}

async function handleFsMenuAction(action) {
  closeFsMenu();

  if (action === 'file') {
    await handleOpenFile();
    return;
  }

  if (action === 'folder') {
    await handleOpenFolder();
    return;
  }

  if (action === 'upload') {
    await handleUploadClick();
  }
}

function bindFsMenu() {
  elements.fsMenuBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleFsMenu();
  });

  elements.fsMenuPanel.querySelectorAll('[data-fs-action]').forEach((item) => {
    item.addEventListener('click', () => {
      handleFsMenuAction(item.dataset.fsAction);
    });
  });

  document.addEventListener('click', (event) => {
    if (!elements.fsMenuBtn.contains(event.target) && !elements.fsMenuPanel.contains(event.target)) {
      closeFsMenu();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeFsMenu();
    }
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
  bindFsMenu();
  elements.uploadFilesInput.addEventListener('change', handleUploadInputChange);
  elements.saveFileBtn.addEventListener('click', () => saveToDisk().catch(() => window.alert('Save failed.')));

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!elements.saveFileBtn.disabled) {
        saveToDisk().catch(() => window.alert('Save failed.'));
      }
    }
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    getValue(STORE_PREFERENCES, THEME_KEY).then((stored) => {
      if (!stored) {
        applyTheme(event.matches ? 'dark' : 'light');
      }
    });
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || window.markyDesktop?.isElectron) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  });
}

function initialize() {
  configureMarked();
  bindEvents();
  bindSplitEvents();
  bindMobileTabs();
  registerServiceWorker();
  applyLayout(LAYOUT_DEFAULT);
  updateSaveButtonState();

  Promise.all([loadTheme(), loadDocument(), loadLayout()])
    .then(([, content]) => {
      setEditorContent(content);
      isReady = true;
      updateFooterStatus('All changes saved');
    })
    .catch(() => {
      setEditorContent(DEFAULT_MARKDOWN);
      isReady = true;
      updateFooterStatus('Offline mode');
      applyTheme(getActiveTheme());
    });
}

initialize();
