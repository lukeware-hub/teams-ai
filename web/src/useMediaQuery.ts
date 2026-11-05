import { useEffect, useState } from 'react';

const mediaOf = (query: string): MediaQueryList | null => (typeof window.matchMedia === 'function' ? window.matchMedia(query) : null);

/** Whether the screen matches the query; false where the browser has no matchMedia. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => mediaOf(query)?.matches ?? false);
  useEffect(() => {
    const media = mediaOf(query);
    if (!media) return;
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}
