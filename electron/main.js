const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const fs = require('fs/promises');
const path = require('path');

const isMac = process.platform === 'darwin';

const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd'];

function isMarkdownFile(name) {
  const lower = name.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function shouldSkipEntry(name) {
  return name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'build';
}

async function readDirectoryTree(dirPath, rootPath = dirPath) {
  const dirents = await fs.readdir(dirPath, { withFileTypes: true });
  const nodes = [];

  for (const dirent of dirents) {
    if (shouldSkipEntry(dirent.name)) continue;

    const fullPath = path.join(dirPath, dirent.name);

    if (dirent.isDirectory()) {
      const children = await readDirectoryTree(fullPath, rootPath);
      if (children.length > 0) {
        nodes.push({
          name: dirent.name,
          path: fullPath,
          type: 'directory',
          children,
          expanded: dirPath === rootPath,
        });
      }
      continue;
    }

    if (dirent.isFile() && isMarkdownFile(dirent.name)) {
      nodes.push({
        name: dirent.name,
        path: fullPath,
        type: 'file',
      });
    }
  }

  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1400,
    height: 840,
    minWidth: 900,
    minHeight: 480,
    title: 'Marky',
    backgroundColor: '#f8fafc',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.loadFile(path.join(__dirname, 'www', 'index.html'));

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

ipcMain.handle('fs:open-file', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] }],
  });

  if (result.canceled || !result.filePaths.length) return null;

  const filePath = result.filePaths[0];
  const content = await fs.readFile(filePath, 'utf8');
  const name = path.basename(filePath);

  return {
    mode: 'file',
    rootName: name,
    rootPath: filePath,
    file: { path: filePath, name, content, dirty: false },
    tree: [{ name, path: filePath, type: 'file' }],
  };
});

ipcMain.handle('fs:upload-files', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] }],
  });

  if (result.canceled || !result.filePaths.length) return null;

  const files = [];
  const tree = [];

  for (const filePath of result.filePaths) {
    const content = await fs.readFile(filePath, 'utf8');
    const name = path.basename(filePath);

    files.push({
      path: filePath,
      name,
      content,
      dirty: false,
    });

    tree.push({
      name,
      path: filePath,
      type: 'file',
    });
  }

  const sortedTree = tree.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return {
    mode: 'folder',
    rootName: 'Uploaded files',
    rootPath: path.dirname(result.filePaths[0]),
    tree: sortedTree,
    files,
    firstPath: sortedTree[0].path,
  };
});

ipcMain.handle('fs:open-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });

  if (result.canceled || !result.filePaths.length) return null;

  const rootPath = result.filePaths[0];
  const tree = await readDirectoryTree(rootPath);

  return {
    mode: 'folder',
    rootName: path.basename(rootPath),
    rootPath,
    tree,
  };
});

ipcMain.handle('fs:read-file', async (_event, filePath) => {
  const content = await fs.readFile(filePath, 'utf8');
  return { path: filePath, content };
});

ipcMain.handle('fs:write-file', async (_event, filePath, content) => {
  await fs.writeFile(filePath, content, 'utf8');
  return { path: filePath, savedAt: Date.now() };
});

ipcMain.handle('fs:read-tree', async (_event, rootPath) => {
  const tree = await readDirectoryTree(rootPath);
  return { rootPath, tree };
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (!isMac) {
    app.quit();
  }
});
