import { Clapperboard, Sparkles, SlidersHorizontal } from 'lucide-react';

import { cn } from '@/lib/cn';
import { useAi } from '@/store/aiStore';
import { useEditor, type RightTab } from '@/store/editorStore';
import { Inspector } from './Inspector';
import { AssistantPanel } from './ai/AssistantPanel';
import { DirectorPanel } from './director/DirectorPanel';
import { DIRECTOR_ENABLED } from '@/types/director';

const TABS: { id: RightTab; label: string; icon: typeof Sparkles }[] = [
  { id: 'inspector', label: 'Inspecteur', icon: SlidersHorizontal },
  { id: 'assistant', label: 'Assistant', icon: Sparkles },
  // The copilot is built and tested but not offered — see `DIRECTOR_ENABLED`.
  ...(DIRECTOR_ENABLED
    ? [{ id: 'director' as const, label: 'Chef monteur', icon: Clapperboard }]
    : []),
];

/**
 * The right column, shared between the inspector, the assistant and the
 * director.
 *
 * A fourth column would have cost the viewer three hundred pixels for a panel
 * that is empty most of the time; all three are "what am I working on right
 * now" surfaces, and none is needed while another is being read.
 *
 * The assistant and the director are deliberately not one tab. The assistant
 * edits the timeline you already have, a turn at a time; the director agrees a
 * whole montage before anything exists. Folding them together would mean one
 * conversation whose answers sometimes touch the document and sometimes
 * describe a proposal, with nothing on screen saying which.
 */
export function RightPanel() {
  const tab = useEditor((state) => state.rightTab);
  const setTab = useEditor((state) => state.setRightTab);
  // A dot rather than a count: the panel is a conversation, not an inbox.
  const working = useAi((state) => state.job !== null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-3 pt-3">
        <div className="flex gap-0.5 rounded-xl border border-white/[0.06] bg-ink-900/50 p-0.5">
          {TABS.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                aria-pressed={active}
                className={cn(
                  'relative flex flex-1 items-center justify-center gap-1.5 rounded-[10px] px-2 py-1.5',
                  'text-2xs font-medium transition-all duration-200 ease-smooth',
                  active
                    ? 'bg-white/[0.07] text-white shadow-[inset_0_1px_0_rgba(255,255,255,.07)]'
                    : 'text-white/40 hover:text-white/70',
                )}
              >
                <Icon size={12} strokeWidth={2.2} />
                {item.label}
                {item.id === 'assistant' && working && !active && (
                  <span className="absolute right-2 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-accent-400" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {/* Anything that is not on offer falls back to the inspector rather
            than rendering nothing — a tab can outlive the switch that shows it. */}
        {tab === 'assistant' ? (
          <AssistantPanel />
        ) : tab === 'director' && DIRECTOR_ENABLED ? (
          <DirectorPanel />
        ) : (
          <Inspector />
        )}
      </div>
    </div>
  );
}
