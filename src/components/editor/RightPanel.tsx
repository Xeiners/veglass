import { Sparkles, SlidersHorizontal } from 'lucide-react';

import { cn } from '@/lib/cn';
import { useAi } from '@/store/aiStore';
import { useEditor, type RightTab } from '@/store/editorStore';
import { Inspector } from './Inspector';
import { AssistantPanel } from './ai/AssistantPanel';

const TABS: { id: RightTab; label: string; icon: typeof Sparkles }[] = [
  { id: 'inspector', label: 'Inspecteur', icon: SlidersHorizontal },
  { id: 'assistant', label: 'Assistant', icon: Sparkles },
];

/**
 * The right column, shared between the inspector and the assistant.
 *
 * A fourth column would have cost the viewer three hundred pixels for a panel
 * that is empty most of the time; the inspector and the assistant are both
 * "what am I working on right now" surfaces, and neither is needed while the
 * other is being read.
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
        {tab === 'assistant' ? <AssistantPanel /> : <Inspector />}
      </div>
    </div>
  );
}
