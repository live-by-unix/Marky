const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('markyDesktop', {
  isElectron: true,
  platform: process.platform,
});
