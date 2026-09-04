import { LineChart, Spline, X } from 'lucide-react';

import { cn } from '@/lib/cn';
import { IconButton } from '@/components/ui/Button';
import { useEditor } from '@/store/editorStore';
import { KeyframeInspector } from './inspector/KeyframeInspector';

/**
 * The animation column.
 *
 * DaVinci opens a dedicated panel next to the inspector as soon as a property
 * can be animated, rather than burying the curve inside the property list — the
 * curve needs width, and it is consulted while the numbers beside it change.
 * Same reasoning here: this sits immediately left of the clip properties.
 */
export function AnimationPanel() {
  const project = useEditor((state) => state.project);
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const expandedClipId = useEditor((state) => state.expandedClipId);
  const graphMode = useEditor((state) => state.graphMode);
  const toggleGraphMode = useEditor((state) => state.toggleGraphMode);
  const setAnimationPanel = useEditor((state) => state.setAnimationPanel);

  const clip =
    project?.clips.find((item) => item.id === (selectedClipId ?? expandedClipId)) ?? null;

  return (
    <aside className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 px-4 pb-2.5 pt-4">
        <Spline size={13} strokeWidth={2} className="text-accent-300" />
        <h2 className="eyebrow min-w-0 flex-1 truncate">Animation</h2>

        <IconButton
          label="Mode courbes dans la timeline (G)"
          className="h-6 w-6"
          active={graphMode}
          onClick={toggleGraphMode}
        >
          <LineChart size={12} strokeWidth={2} />
        </IconButton>
        <IconButton
          label="Fermer le panneau"
          className="h-6 w-6"
          onClick={() => setAnimationPanel(false)}
        >
          <X size={12} strokeWidth={2.2} />
        </IconButton>
      </header>

      {clip && (
        <p className="shrink-0 truncate px-4 pb-2 text-[10px] text-white/28">
          {clip.label ?? 'Clip'}
        </p>
      )}

      <div className={cn('min-h-0 flex-1 overflow-y-auto px-4 pb-5')}>
        <KeyframeInspector />
      </div>
    </aside>
  );
}
