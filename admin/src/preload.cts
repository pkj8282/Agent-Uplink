// 렌더러에 admin API만 노출한다. 샌드박스 프리로드는 CommonJS여야 하므로 .cts(→ preload.cjs).
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("admin", {
  snapshot: () => ipcRenderer.invoke("admin:snapshot"),
  setConfig: (patch: unknown) => ipcRenderer.invoke("admin:setConfig", patch),
  deleteChannel: (channelId: string) => ipcRenderer.invoke("admin:deleteChannel", channelId),
  deleteServer: (serverId: string) => ipcRenderer.invoke("admin:deleteServer", serverId),
  deleteAccount: (uuid: string) => ipcRenderer.invoke("admin:deleteAccount", uuid),
  deleteDm: (channelId: string) => ipcRenderer.invoke("admin:deleteDm", channelId),
  restoreTrash: (id: string, confirmRename: boolean) => ipcRenderer.invoke("admin:restoreTrash", { id, confirmRename }),
  emptyTrash: () => ipcRenderer.invoke("admin:emptyTrash"),
  openViewer: () => ipcRenderer.invoke("admin:openViewer"),
  getLanguage: () => ipcRenderer.invoke("admin:getLanguage"),
  setLanguage: (lang: string) => ipcRenderer.invoke("admin:setLanguage", lang),
});
