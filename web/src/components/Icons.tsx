export type IconName = 'claude' | 'github' | 'user' | 'external' | 'send' | 'close' | 'terminal' | 'chevron';

export function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (name === 'claude') {
    return <svg {...common} viewBox="0 0 32 32" strokeWidth="2.7"><path d="M16 3v26M3 16h26M6.8 6.8l18.4 18.4M25.2 6.8 6.8 25.2M9.6 4.6l12.8 22.8M22.4 4.6 9.6 27.4M4.6 9.6l22.8 12.8M27.4 9.6 4.6 22.4" /></svg>;
  }
  if (name === 'github') {
    return <svg {...common} fill="currentColor" stroke="none" viewBox="0 0 24 24"><path d="M12 2.4a9.6 9.6 0 0 0-3 18.72c.48.09.66-.21.66-.46v-1.68c-2.67.58-3.23-1.13-3.23-1.13-.44-1.11-1.08-1.4-1.08-1.4-.87-.6.07-.59.07-.59.96.07 1.47.99 1.47.99.85 1.46 2.23 1.04 2.77.8.09-.62.33-1.04.6-1.28-2.13-.24-4.37-1.06-4.37-4.74 0-1.05.38-1.9 1-2.57-.1-.24-.43-1.22.1-2.54 0 0 .82-.26 2.64.98a9.2 9.2 0 0 1 4.8 0c1.82-1.24 2.64-.98 2.64-.98.53 1.32.2 2.3.1 2.54.62.67 1 1.52 1 2.57 0 3.69-2.24 4.5-4.38 4.74.34.29.64.86.64 1.74v2.59c0 .25.18.55.67.46A9.6 9.6 0 0 0 12 2.4Z" /></svg>;
  }
  if (name === 'user') {
    return <svg {...common}><circle cx="12" cy="8" r="3.2" /><path d="M5.5 20c.8-3.1 3-4.7 6.5-4.7s5.7 1.6 6.5 4.7" /></svg>;
  }
  if (name === 'external') {
    return <svg {...common}><path d="M14 5h5v5M19 5l-8 8" /><path d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>;
  }
  if (name === 'send') {
    return <svg {...common}><path d="m21 3-7.2 18-3.2-7.6L3 10.2 21 3Z" /><path d="M10.6 13.4 21 3" /></svg>;
  }
  if (name === 'close') {
    return <svg {...common}><path d="m6 6 12 12M18 6 6 18" /></svg>;
  }
  if (name === 'terminal') {
    return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></svg>;
  }
  return <svg {...common}><path d="m6 9 6 6 6-6" /></svg>;
}
