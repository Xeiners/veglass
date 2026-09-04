import { cn } from '@/lib/cn';

export interface SliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange(value: number): void;
  className?: string;
  'aria-label'?: string;
}

/**
 * Range input with a painted fill. The track gradient is computed inline so the
 * accent follows the value without a second element to keep in sync.
 */
export function Slider({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onChange,
  className,
  ...aria
}: SliderProps) {
  const ratio = max === min ? 0 : ((value - min) / (max - min)) * 100;

  return (
    <input
      type="range"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(event) => onChange(Number(event.target.value))}
      style={{
        background: `linear-gradient(to right, rgb(99 102 241) 0%, rgb(99 102 241) ${ratio}%, rgba(255,255,255,.09) ${ratio}%, rgba(255,255,255,.09) 100%)`,
      }}
      className={cn(
        'h-1 w-full cursor-pointer appearance-none rounded-full outline-none',
        // WebKit thumb
        '[&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5',
        '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full',
        '[&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_1px_4px_rgba(0,0,0,.55)]',
        '[&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-150',
        'hover:[&::-webkit-slider-thumb]:scale-110 active:[&::-webkit-slider-thumb]:scale-95',
        // Firefox thumb
        '[&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:border-0',
        '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white',
        className,
      )}
      {...aria}
    />
  );
}
