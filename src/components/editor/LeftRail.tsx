import { Activity, FolderOpen, Globe, Wand2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { useEditor, type LeftTab } from '@/store/editorStore';
import { EffectsPanel } from './EffectsPanel';
import { MediaPool } from './MediaPool';
import { MixerPanel } from './MixerPanel';
import { OnlinePanel } from './online/OnlinePanel';

const TABS: { id: LeftTab; label: string; icon: typeof Wand2 }[] = [
  { id: 'media', label: 'Médias', icon: FolderOpen },
  { id: 'effects', label: 'Effets', icon: Wand2 },
  { id: 'mixer', label: 'Mixage', icon: Activity },
  { id: 'online', label: 'En ligne', icon: Globe },
];

/** Library column: local material, effects, the mixer, and what is being fetched. */
export function LeftRail() {
  const tab = useEditor((state) => state.leftTab);
  const setTab = useEditor((state) => state.setLeftTab);

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
                  'flex flex-1 items-center justify-center gap-1.5 rounded-[10px] px-2 py-1.5',
                  'text-2xs font-medium transition-all duration-200 ease-smooth',
                  active
                    ? 'bg-white/[0.07] text-white shadow-[inset_0_1px_0_rgba(255,255,255,.07)]'
                    : 'text-white/40 hover:text-white/70',
                )}
              >
                <Icon size={12} strokeWidth={2.2} />
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {tab === 'media' ? (
          <MediaPool />
        ) : tab === 'effects' ? (
          <EffectsPanel />
        ) : tab === 'mixer' ? (
          <MixerPanel />
        ) : (
          <OnlinePanel />
        )}
      </div>
    </div>
  );
}
