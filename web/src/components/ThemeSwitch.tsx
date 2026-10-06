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
    <div className="theme-switch" role="group" aria-label="Tema da interface">
      {OPTIONS.map((o) => (
        <button key={o.value} type="button" aria-label={o.label} title={o.label} aria-pressed={preference === o.value} onClick={() => setPreference(o.value)}>
          <Icon name={o.icon} size={16} />
        </button>
      ))}
    </div>
  );
}
