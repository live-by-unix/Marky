const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('markyDesktop', {
  isElectron: true,
  platform: process.platform,
});

contextBridge.exposeInMainWorld('markyFs', {
  openFile: () => ipcRenderer.invoke('fs:open-file'),
  openFolder: () => ipcRenderer.invoke('fs:open-folder'),
  uploadFiles: () => ipcRenderer.invoke('fs:upload-files'),
  readFile: (filePath) => ipcRenderer.invoke('fs:read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:write-file', filePath, content),
  readTree: (rootPath) => ipcRenderer.invoke('fs:read-tree', rootPath),
});
