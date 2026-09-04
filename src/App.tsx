import { useEffect } from 'react';

import { HomeDashboard } from '@/components/home/HomeDashboard';
import { Workspace } from '@/components/editor/Workspace';
import { FfmpegSetupDialog } from '@/components/editor/FfmpegSetup';
import { ContextMenu } from '@/components/ui/ContextMenu';
import { Toaster } from '@/components/ui/Toaster';
import { AiSettingsModal } from '@/components/editor/ai/AiSettingsModal';
import { SmartCutDialog } from '@/components/editor/ai/SmartCutDialog';
import { SubtitleDialog } from '@/components/editor/ai/SubtitleDialog';
import { MediaBrowser } from '@/components/editor/online/MediaBrowser';
import { BannerPicker } from '@/components/editor/banner/BannerPicker';
import { ViralWizard } from '@/components/editor/viral/ViralWizard';
import { UpdateDialog } from '@/components/UpdateDialog';
import { TutorialWizard } from '@/components/editor/tutorial/TutorialWizard';
import { audioEngine } from '@/lib/audioEngine';
import { useEditor } from '@/store/editorStore';
import { useAi } from '@/store/aiStore';
import { useDownloads } from '@/store/downloadStore';
import { useVoice } from '@/store/voiceStore';

export function App() {
  const view = useEditor((state) => state.view);
  const boot = useEditor((state) => state.boot);
  const bootAi = useAi((state) => state.boot);
  const bootDownloads = useDownloads((state) => state.boot);
  const bootVoice = useVoice((state) => state.boot);

  useEffect(() => {
    void boot();
    // Reads only *whether* a key exists — never the key — so the assistant can
    // show the right empty state on the first frame instead of flashing one.
    void bootAi();
    // Reads whether yt-dlp is present and opens the progress bridge, so the
    // rail shows the right state on the first frame rather than flashing one.
    void bootDownloads();
    // Reads only *whether* an ElevenLabs key exists, then the account's voice
    // list, so the tutorial wizard knows on its first frame whether it can
    // offer a voice-over at all.
    void bootVoice();
  }, [boot, bootAi, bootDownloads, bootVoice]);

  /**
   * Browser zoom is disabled application-wide.
   *
   * A trackpad pinch reaches the page as `wheel` with `ctrlKey` set, and the
   * default response — scaling the document — makes the layout larger than the
   * window and lets the whole interface be panned around. The timeline claims
   * that gesture for itself (see its own wheel handler); everywhere else it is
   * simply swallowed.
   */
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    };
    const onGesture = (event: Event) => event.preventDefault();
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (!['+', '-', '=', '0'].includes(event.key)) return;
      event.preventDefault();
      // Route the intent to the timeline instead of the document.
      const state = useEditor.getState();
      if (event.key === '0') state.setZoom(64);
      else state.zoomBy(event.key === '-' ? 0.8 : 1.25);
    };

    window.addEventListener('wheel', onWheel, { passive: false });
    // Safari-style pinch events; harmless where they never fire.
    window.addEventListener('gesturestart', onGesture);
    window.addEventListener('gesturechange', onGesture);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('gesturestart', onGesture);
      window.removeEventListener('gesturechange', onGesture);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  /**
   * The application supplies its own right-click menus, so the native one is
   * suppressed — except over editable text, where the browser's copy/paste is
   * more useful than anything we would replace it with.
   */
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const editable =
        target?.isContentEditable ||
        ['INPUT', 'TEXTAREA'].includes(target?.tagName ?? '');
      if (!editable) event.preventDefault();
    };
    window.addEventListener('contextmenu', onContextMenu);
    return () => window.removeEventListener('contextmenu', onContextMenu);
  }, []);

  /**
   * An AudioContext built before any interaction starts suspended, and a
   * suspended context is silent. One gesture is all it takes to release it.
   */
  useEffect(() => {
    const wake = () => void audioEngine.resume();
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, []);

  // Flush pending edits if the window goes away mid-session.
  useEffect(() => {
    const onBeforeUnload = () => {
      const { dirty, saveProject } = useEditor.getState();
      if (dirty) void saveProject();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  return (
    <div className="h-full bg-ink-900 text-white/80">
      {view === 'editor' ? <Workspace /> : <HomeDashboard />}
      <ContextMenu />
      {/* Offered once at launch when the machine has no encoder; the export
          panel carries the same offer for anyone who says "plus tard". */}
      <FfmpegSetupDialog />
      {/* Portalled dialogs: reachable from the top bar, the timeline toolbar and
          the assistant alike, so none of them owns the other's state. */}
      <AiSettingsModal />
      <SubtitleDialog />
      <SmartCutDialog />
      <MediaBrowser />
      <BannerPicker />
      <ViralWizard />
      <TutorialWizard />
      {/* Silent until there is genuinely a newer version — see `lib/updater`. */}
      <UpdateDialog />
      <Toaster />
    </div>
  );
}
