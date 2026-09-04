/**
 * The app runs in two hosts: the Tauri webview (native file access, disk
 * persistence) and a plain browser during `npm run dev` (blob URLs,
 * localStorage). Everything native is behind this check and lazily imported so
 * the browser build never touches the Tauri IPC bridge.
 */
export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
}

export const hostLabel = (): string => (isTauri() ? 'Desktop' : 'Navigateur');

/**
 * Opens a link outside the application.
 *
 * A webview has no notion of a new tab, so an anchor with `target="_blank"`
 * does nothing at all under Tauri — it does not fail, it simply goes nowhere.
 * The desktop host therefore hands the URL to the operating system through a
 * command; the browser host opens a tab, as it always could.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_external', { url });
}
