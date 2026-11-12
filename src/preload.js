'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  snapshot: () => ipcRenderer.invoke('app:snapshot'),
  chooseGameDir: () => ipcRenderer.invoke('app:chooseGameDir'),
  setGameDir: (dir) => ipcRenderer.invoke('app:setGameDir', { dir }),
  setWorkshopDir: (dir) => ipcRenderer.invoke('app:setWorkshopDir', { dir }),
  openPath: (target) => ipcRenderer.invoke('app:openPath', { target }),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', { url }),
  openLogs: () => ipcRenderer.invoke('app:openLogs'),
  rescan: () => ipcRenderer.invoke('mods:rescan'),
  analyze: (jarNames) => ipcRenderer.invoke('mods:analyze', { jarNames }),
  withDependencies: (jarNames) => ipcRenderer.invoke('mods:withDependencies', { jarNames }),
  selectProfile: (name) => ipcRenderer.invoke('profile:select', { name }),
  saveProfile: (name, jarNames) => ipcRenderer.invoke('profile:save', { name, jarNames }),
  createProfile: (name, copyFrom) => ipcRenderer.invoke('profile:create', { name, copyFrom }),
  duplicateProfile: (name) => ipcRenderer.invoke('profile:duplicate', { name }),
  renameProfile: (from, to) => ipcRenderer.invoke('profile:rename', { from, to }),
  deleteProfile: (name) => ipcRenderer.invoke('profile:delete', { name }),
  updateProfileMeta: (name, description) => ipcRenderer.invoke('profile:updateMeta', { name, description }),
  launch: (profile, jarNames) => ipcRenderer.invoke('game:launch', { profile, jarNames }),
  listLogs: () => ipcRenderer.invoke('logs:list'),
  readLog: (file) => ipcRenderer.invoke('logs:read', { file }),
  hookStatus: () => ipcRenderer.invoke('steam:hookStatus'),
  installHook: () => ipcRenderer.invoke('steam:installHook'),
  removeHook: () => ipcRenderer.invoke('steam:removeHook'),
  onHookUpdated: (callback) => ipcRenderer.on('hook:updated', () => callback()),
  onHookAutoInstalled: (callback) => ipcRenderer.on('hook:auto-installed', () => callback()),
});
