import { type ThemePreference, useThemePreference } from '../theme.js';
import { Icon, type IconName } from './Icons.js';

const OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; icon: IconName }> = [
  { value: 'light', label: 'Tema claro', icon: 'sun' },
  { value: 'dark', label: 'Tema escuro', icon: 'moon' },
  { value: 'system', label: 'Usar o tema do sistema', icon: 'monitor' },
];

export function ThemeSwitch() {
  const [preference, setPreference] = useThemePreference();
  return (
    <div className="flex gap-1 rounded-tile border border-line bg-surface-sunken p-1 md:flex-col" role="group" aria-label="Tema da interface">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className="relative min-w-[auto] grid size-8 place-items-center rounded-md border-transparent bg-transparent p-0 text-ink-soft pointer-coarse:after:absolute pointer-coarse:after:-inset-[7px] pointer-coarse:after:content-[''] hover:text-ink aria-pressed:border-line-strong aria-pressed:bg-surface aria-pressed:text-ink aria-pressed:shadow-button"
          aria-label={o.label}
          title={o.label}
          aria-pressed={preference === o.value}
          onClick={() => setPreference(o.value)}
        >
          <Icon name={o.icon} size={16} />
        </button>
      ))}
    </div>
  );
}
