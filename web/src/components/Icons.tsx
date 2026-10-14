export type IconName = 'claude' | 'github' | 'user' | 'external' | 'send' | 'close' | 'chevron' | 'terminal' | 'check' | 'file' | 'clipboard' | 'shield' | 'clock' | 'list' | 'lock' | 'home' | 'copy' | 'download' | 'play' | 'info' | 'lightbulb' | 'sun' | 'moon' | 'monitor' | 'arrow-left' | 'arrow-right' | 'search' | 'plus' | 'refresh' | 'alert' | 'chevron-right' | 'stop' | 'code' | 'server' | 'trash' | 'grid' | 'folder' | 'activity' | 'sort' | 'sort-up' | 'sort-down' | 'chat';

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
  if (name === 'check') return <svg {...common}><path d="m5 12 4.5 4.5L19 7" /></svg>;
  if (name === 'file') return <svg {...common}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></svg>;
  if (name === 'clipboard') return <svg {...common}><rect x="6" y="5" width="12" height="16" rx="2" /><path d="M9 5V3h6v2M9 11h6M9 15h4" /></svg>;
  if (name === 'shield') return <svg {...common}><path d="M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6z" /><path d="m8.5 12 2.2 2.2 4.8-5" /></svg>;
  if (name === 'clock') return <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></svg>;
  if (name === 'list') return <svg {...common}><path d="M9 6h10M9 12h10M9 18h10" /><path d="M5 6h.01M5 12h.01M5 18h.01" /></svg>;
  if (name === 'lock') return <svg {...common}><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;
  if (name === 'home') return <svg {...common}><path d="m4 11 8-7 8 7" /><path d="M6 10v9h12v-9M10 19v-5h4v5" /></svg>;
  if (name === 'copy') return <svg {...common}><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
  if (name === 'download') return <svg {...common}><path d="M12 4v10M8 11l4 4 4-4M5 19h14" /></svg>;
  if (name === 'play') return <svg {...common} fill="currentColor" stroke="none"><path d="m8 5 11 7-11 7z" /></svg>;
  if (name === 'info') return <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></svg>;
  if (name === 'lightbulb') return <svg {...common}><path d="M9 18h6M10 21h4M8.5 14.5a6 6 0 1 1 7 0c-.8.6-1.2 1.3-1.3 2.5h-4.4c-.1-1.2-.5-1.9-1.3-2.5Z" /></svg>;
  if (name === 'sun') return <svg {...common}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></svg>;
  if (name === 'moon') return <svg {...common}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></svg>;
  if (name === 'monitor') return <svg {...common}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>;
  if (name === 'arrow-left') return <svg {...common}><path d="M19 12H5M11 6l-6 6 6 6" /></svg>;
  if (name === 'arrow-right') return <svg {...common}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
  if (name === 'sort') return <svg {...common}><path d="m8 9 4-4 4 4M8 15l4 4 4-4" /></svg>;
  if (name === 'sort-up') return <svg {...common}><path d="M12 19V5M6 11l6-6 6 6" /></svg>;
  if (name === 'sort-down') return <svg {...common}><path d="M12 5v14M6 13l6 6 6-6" /></svg>;
  if (name === 'search') return <svg {...common}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>;
  if (name === 'plus') return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
  if (name === 'refresh') return <svg {...common}><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4" /></svg>;
  if (name === 'alert') return <svg {...common}><path d="M12 4 21 19.5H3z" /><path d="M12 10v4M12 17h.01" /></svg>;
  if (name === 'chevron-right') return <svg {...common}><path d="m9 6 6 6-6 6" /></svg>;
  if (name === 'code') return <svg {...common}><path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5.5l-3 13" /></svg>;
  if (name === 'server') return <svg {...common}><rect x="3.5" y="4" width="17" height="6.5" rx="1.5" /><rect x="3.5" y="13.5" width="17" height="6.5" rx="1.5" /><path d="M7.5 7.25h.01M7.5 16.75h.01" /></svg>;
  if (name === 'stop') return <svg {...common}><rect x="6.5" y="6.5" width="11" height="11" rx="1.5" /></svg>;
  if (name === 'trash') return <svg {...common}><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0-.9 13.1a2 2 0 0 1-2 1.9H8.9a2 2 0 0 1-2-1.9L6 7M10 11v6M14 11v6" /></svg>;
  if (name === 'grid') return <svg {...common}><path d="M6 6h.01M12 6h.01M18 6h.01M6 12h.01M12 12h.01M18 12h.01M6 18h.01M12 18h.01M18 18h.01" strokeWidth="3.2" /></svg>;
  if (name === 'folder') return <svg {...common}><path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /></svg>;
  if (name === 'chat') return <svg {...common}><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" /><path d="M8 9h8M8 12h5" /></svg>;
  if (name === 'activity') return <svg {...common}><rect x="3.5" y="3.5" width="17" height="17" rx="3" /><path d="M8 15v-3M12 15V9M16 15v-5" /></svg>;
  if (name === 'terminal') {
    return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></svg>;
  }
  return <svg {...common}><path d="m6 9 6 6 6-6" /></svg>;
}
