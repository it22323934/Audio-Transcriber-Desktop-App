// Exposes window.toru (see src/shared/bridge.ts) to TORU's pages. Pages get
// no Node.js access; everything goes through these IPC calls.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type ToruBridge } from '../src/shared/bridge';

const env = ipcRenderer.sendSync(IPC.env) as ToruBridge['env'] | null;

function listen<T>(channel: string) {
  return (listener: (value: T) => void) => {
    const handler = (_e: IpcRendererEvent, value: T) => listener(value);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  };
}

if (env) {
  const api: ToruBridge = {
    env,
    recorder: {
      call: (cmd) => ipcRenderer.invoke(IPC.recorderCall, cmd),
      ready: () => ipcRenderer.send(IPC.recorderReady),
      publish: (state) => ipcRenderer.send(IPC.recorderState, state),
    },
    secrets: {
      getApiKey: () => ipcRenderer.invoke(IPC.getApiKey),
      setApiKey: (key) => ipcRenderer.invoke(IPC.setApiKey, key),
    },
    app: {
      show: (route) => ipcRenderer.send(IPC.show, route),
      onNavigate: listen<string>(IPC.navigate),
      setTheme: (theme) => ipcRenderer.send(IPC.theme, theme),
      syncPrefs: (prefs) => ipcRenderer.send(IPC.prefs, prefs),
      openExternal: (url) => ipcRenderer.send(IPC.openExternal, url),
      openMicSettings: () => ipcRenderer.send(IPC.openMicSettings),
    },
    meetings: {
      active: () => ipcRenderer.invoke(IPC.meetingsActive),
      onChange: listen<string[]>(IPC.meetingsChanged),
    },
    widget: {
      state: () => ipcRenderer.invoke(IPC.widgetState),
      onState: listen(IPC.widgetChanged),
      act: (action) => ipcRenderer.send(IPC.widgetAct, action),
    },
    ...(env.test ? { test: { meeting: (app: string, active: boolean) => ipcRenderer.send(IPC.testMeeting, app, active) } } : {}),
  };
  contextBridge.exposeInMainWorld('toru', api);
}
