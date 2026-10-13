export interface WindowSection {
  title: string;
  text: string;
}

/** The sections cut at line breaks into windows of at most `max` characters; a window that starts mid-section says which one. */
export function splitSections(sections: readonly WindowSection[], max: number): string[] {
  const windows: string[] = [];
  let current = '';
  for (const { title, text } of sections) {
    const lines = [`${title}:`, ...text.split('\n').flatMap((line) => line.match(new RegExp(`[^]{1,${max - 100}}`, 'g')) ?? [''])];
    lines.forEach((line, i) => {
      if (current.length + line.length + 1 > max) {
        windows.push(current);
        current = '';
      }
      current += `${current === '' && i > 0 ? `${title} (continued):\n` : ''}${line}\n`;
    });
  }
  return current === '' ? windows : [...windows, current];
}
