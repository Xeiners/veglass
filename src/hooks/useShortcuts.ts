import { useEffect } from 'react';

import { projectDuration, useEditor } from '@/store/editorStore';

/**
 * Fields where a space bar genuinely means "type a space".
 *
 * Deliberately narrow: a button, a slider or a colour swatch are *focusable*,
 * but none of them has any business swallowing the transport key.
 */
const TEXT_ENTRY_TYPES = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'number',
]);

const isTextEntry = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  if (target instanceof HTMLInputElement) {
    return TEXT_ENTRY_TYPES.has(target.type);
  }
  return target.closest('[data-capture-keys]') !== null;
};

/**
 * Anything that owns the keyboard while focused.
 *
 * Editing a clip label must never trigger a transport command, so the shortcut
 * map bails out here first. A range input counts too: the arrow keys belong to
 * it while it has focus.
 */
const isTypingTarget = (target: EventTarget | null): boolean => {
  if (isTextEntry(target)) return true;
  if (!(target instanceof HTMLElement)) return false;
  // A slider or a colour swatch keeps its arrows, but not the space bar.
  return target.tagName === 'INPUT';
};

/** Editing keyboard map. Mirrors the shortcuts listed in the help popover. */
export function useShortcuts(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const state = useEditor.getState();
      // Ctrl only. The Command key is deliberately not bound: this build is
      // driven from a Windows keyboard, and accepting both made every label a
      // "⌘/Ctrl" that read as noise.
      const meta = event.ctrlKey;

      /*
       * Space is the transport, wherever the focus happens to be.
       *
       * It is handled before every other rule because a focused control would
       * otherwise claim it: a `<button>` treats the space bar as a click, so
       * after pressing Play once, pressing space again would press Play's own
       * button rather than reach the transport. Cancelling the default on both
       * key events is what takes that away.
       *
       * The transport itself now fires on *release*, because holding space
       * turns the timeline into a hand tool. A hold that panned the view must
       * not also start playback, and only keyup knows whether it did.
       */
      if (event.code === 'Space' && !meta && !event.altKey) {
        if (isTextEntry(event.target)) return;
        event.preventDefault();
        if (!event.repeat) state.setSpaceHeld(true);
        return;
      }

      if (isTypingTarget(event.target)) return;

      // Undo / redo first: they must win over any single-letter binding.
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) state.redo();
        else state.undo();
        return;
      }
      if (meta && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        state.redo();
        return;
      }
      // After Effects' own keyboard grammar for revealing/keying a property.
      if (event.altKey && event.shiftKey && !meta) {
        const channel = { p: 'x', s: 'scale', r: 'rotation', t: 'opacity' }[
          event.key.toLowerCase()
        ];
        if (channel && state.selectedClipId) {
          event.preventDefault();
          const clip = state.project?.clips.find((item) => item.id === state.selectedClipId);
          const animated = (clip?.animation?.[channel]?.length ?? 0) > 0;
          if (animated) state.addKeyframeAt(state.selectedClipId, channel);
          else state.toggleChannel(state.selectedClipId, channel);
          return;
        }
      }

      if (meta && event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault();
        state.addTextClip();
        return;
      }

      if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void state.saveProject();
        state.notify('Projet enregistré', 'success');
        return;
      }

      // Copy and paste act on whatever is being worked on: keyframes when some
      // are selected — you are editing a curve — and clips otherwise.
      if (meta && event.key.toLowerCase() === 'c') {
        const keyframes = state.selectedKeyframes.length > 0;
        if (!keyframes && state.selectedClipIds.length === 0) return;
        event.preventDefault();
        if (keyframes) state.copyKeyframes();
        else state.copyClips();
        return;
      }
      if (meta && event.key.toLowerCase() === 'v') {
        const toKeyframes = state.selectedKeyframes.length > 0 && state.keyframeClipboard;
        if (!toKeyframes && !state.clipClipboard && !state.keyframeClipboard) return;
        event.preventDefault();
        if (toKeyframes || !state.clipClipboard) state.pasteKeyframes();
        else state.pasteClips();
        return;
      }

      if (meta && event.key.toLowerCase() === 'd' && state.selectedClipIds.length > 0) {
        event.preventDefault();
        state.duplicateClips(state.selectedClipIds);
        return;
      }

      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          state.nudgePlayhead(event.shiftKey ? -10 : -1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          state.nudgePlayhead(event.shiftKey ? 10 : 1);
          break;
        case 'Home':
          event.preventDefault();
          state.setPlayhead(0);
          break;
        case 'End':
          event.preventDefault();
          state.setPlayhead(projectDuration(state.project));
          break;
        case 'Delete':
        case 'Backspace':
          if (state.selectedKeyframes.length > 0) {
            event.preventDefault();
            state.removeKeyframes(state.selectedKeyframes);
          } else if (state.selectedClipIds.length > 0) {
            event.preventDefault();
            state.removeSelectedClips();
          } else if (state.selectedTransitionId) {
            event.preventDefault();
            state.removeTransition(state.selectedTransitionId);
          }
          break;
        case 'Escape':
          state.selectKeyframes([]);
          state.selectClip(null);
          break;
        default:
          break;
      }

      if (meta) return;

      switch (event.key.toLowerCase()) {
        case 's':
          event.preventDefault();
          state.splitAtPlayhead();
          break;
        case 'k':
          event.preventDefault();
          state.keyAllChannels();
          break;
        case 'g':
          event.preventDefault();
          state.toggleGraphMode();
          break;
        case 'i':
          event.preventDefault();
          state.setWorkIn();
          break;
        case 'o':
          event.preventDefault();
          state.setWorkOut();
          break;
        case 'x':
          event.preventDefault();
          state.clearWorkArea();
          break;
        case 'n':
          state.toggleSnap();
          break;
        case 'l':
          state.toggleLoop();
          break;
        case 'm':
          state.toggleMasterMute();
          break;
        case '+':
        case '=':
          state.zoomBy(1.25);
          break;
        case '-':
          state.zoomBy(0.8);
          break;
        default:
          break;
      }
    };

    /**
     * The matching keyup, which is where play/pause actually happens.
     *
     * Cancelling the default here too is what keeps a focused button from
     * treating the space bar as a click — activation fires on keyup, from
     * whether the keydown was cancelled.
     */
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      if (isTextEntry(event.target)) return;
      event.preventDefault();

      const state = useEditor.getState();
      if (!state.spaceHeld) return;
      const panned = state.spacePanned;
      state.setSpaceHeld(false);
      // A hold that dragged the timeline was a pan, not a transport command.
      if (!panned) state.togglePlay();
    };

    // Alt-tabbing away mid-hold never delivers the keyup, and the timeline
    // would stay stuck in hand-tool mode until space were pressed again.
    const onBlur = () => useEditor.getState().setSpaceHeld(false);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [enabled]);
}
