const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd'];

function isMarkdownFile(name) {
  const lower = name.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function shouldSkipEntry(name) {
  return name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'build';
}

function sortTreeNodes(nodes) {
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function getElectronApi() {
  return window.markyFs || null;
}

export function hasDiskAccess() {
  return Boolean(getElectronApi()) || 'showOpenFilePicker' in window;
}

export async function pickUploadFilesElectron() {
  const electron = getElectronApi();
  if (!electron?.uploadFiles) return null;
  return electron.uploadFiles();
}

export async function ingestUploadedFiles(fileList) {
  const fileEntries = [];
  const treeNodes = [];

  for (const file of fileList) {
    if (!isMarkdownFile(file.name)) continue;

    const content = await file.text();
    const path = fileList.length > 1 ? `uploads/${file.name}` : file.name;

    fileEntries.push({
      path,
      name: file.name,
      content,
      dirty: false,
      isUpload: true,
    });

    treeNodes.push({
      name: file.name,
      path,
      type: 'file',
    });
  }

  if (!fileEntries.length) {
    throw new Error('No markdown files selected');
  }

  const sortedNodes = sortTreeNodes(treeNodes);
  const tree =
    sortedNodes.length > 1
      ? [
          {
            name: 'Uploads',
            path: 'uploads',
            type: 'directory',
            expanded: true,
            children: sortedNodes,
          },
        ]
      : sortedNodes;

  const firstPath = sortedNodes[0].path;

  return {
    mode: 'upload',
    rootName: 'Uploaded files',
    tree,
    files: fileEntries,
    firstPath,
  };
}

export async function promptSaveUploadedFile(fileEntry, content) {
  if (!('showSaveFilePicker' in window)) {
    throw new Error('Save picker unavailable');
  }

  const handle = await window.showSaveFilePicker({
    suggestedName: fileEntry.name,
    types: [
      {
        description: 'Markdown',
        accept: { 'text/markdown': MARKDOWN_EXTENSIONS },
      },
    ],
  });

  await writeWebFile(handle, content);
  fileEntry.handle = handle;
  fileEntry.isUpload = false;
  fileEntry.path = handle.name;
  fileEntry.name = handle.name;

  return { path: handle.name, savedAt: Date.now() };
}

export async function pickMarkdownFile() {
  const electron = getElectronApi();
  if (electron) return electron.openFile();

  const [handle] = await window.showOpenFilePicker({
    multiple: false,
    types: [
      {
        description: 'Markdown',
        accept: { 'text/markdown': MARKDOWN_EXTENSIONS },
      },
    ],
  });

  const file = await handle.getFile();
  const content = await file.text();

  return {
    mode: 'file',
    rootName: handle.name,
    file: {
      path: handle.name,
      name: handle.name,
      handle,
      content,
      dirty: false,
    },
    tree: [
      {
        name: handle.name,
        path: handle.name,
        type: 'file',
      },
    ],
  };
}

export async function pickMarkdownFolder() {
  const electron = getElectronApi();
  if (electron) return electron.openFolder();

  const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  const tree = await buildWebTree(dirHandle, '');
  const rootName = dirHandle.name;

  return {
    mode: 'folder',
    rootName,
    rootHandle: dirHandle,
    tree,
    files: new Map(),
  };
}

async function buildWebTree(dirHandle, basePath) {
  const nodes = [];

  for await (const [name, handle] of dirHandle.entries()) {
    if (shouldSkipEntry(name)) continue;

    const path = basePath ? `${basePath}/${name}` : name;

    if (handle.kind === 'directory') {
      const children = await buildWebTree(handle, path);
      if (children.length > 0) {
        nodes.push({
          name,
          path,
          type: 'directory',
          handle,
          children,
          expanded: basePath === '',
        });
      }
      continue;
    }

    if (handle.kind === 'file' && isMarkdownFile(name)) {
      nodes.push({
        name,
        path,
        type: 'file',
        handle,
      });
    }
  }

  return sortTreeNodes(nodes);
}

export async function readWebFile(handle) {
  const file = await handle.getFile();
  return file.text();
}

export async function writeWebFile(handle, content) {
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

export async function loadFileContent(entry, context) {
  if (entry.handle) {
    const content = await readWebFile(entry.handle);
    return { path: entry.path, name: entry.name, handle: entry.handle, content, dirty: false };
  }

  const electron = getElectronApi();
  if (electron && entry.path) {
    const result = await electron.readFile(entry.path);
    return {
      path: entry.path,
      name: entry.name,
      content: result.content,
      dirty: false,
    };
  }

  if (context.mode === 'file' && context.file) {
    return context.file;
  }

  throw new Error('Unable to read file');
}

export async function saveFileToDisk(fileEntry, content, context) {
  if (fileEntry.handle) {
    await writeWebFile(fileEntry.handle, content);
    return { path: fileEntry.path, savedAt: Date.now() };
  }

  const electron = getElectronApi();
  if (electron && fileEntry.path) {
    await electron.writeFile(fileEntry.path, content);
    return { path: fileEntry.path, savedAt: Date.now() };
  }

  if (context.mode === 'file' && context.file?.handle) {
    await writeWebFile(context.file.handle, content);
    return { path: context.file.path, savedAt: Date.now() };
  }

  if (fileEntry.isUpload) {
    return promptSaveUploadedFile(fileEntry, content);
  }

  throw new Error('No writable file target');
}

export async function refreshElectronTree(rootPath) {
  const electron = getElectronApi();
  if (!electron) return null;
  const tree = await electron.readTree(rootPath);
  return { mode: 'folder', rootName: rootPath.split(/[/\\]/).pop() || rootPath, rootPath, tree };
}
