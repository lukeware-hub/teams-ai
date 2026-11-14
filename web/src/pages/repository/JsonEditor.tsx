import { useRef, type KeyboardEvent } from 'react';

/** A text editor in a monospace face with the line numbers beside it, which scroll with the text. */
export function JsonEditor({ value, onChange, onKeyDown, label, testId, placeholder }: { value: string; onChange: (value: string) => void; onKeyDown?: (e: KeyboardEvent) => void; label: string; testId: string; placeholder?: string }) {
  const gutter = useRef<HTMLPreElement>(null);
  const lines = Array.from({ length: Math.max(1, value.split('\n').length) }, (_, i) => i + 1).join('\n');
  return (
    <div className="flex h-56 min-w-0 overflow-hidden rounded-lg border border-line bg-surface-sunken font-mono text-[0.8125rem] leading-5">
      <pre ref={gutter} aria-hidden="true" className="m-0 w-10 flex-none overflow-hidden border-r border-line px-2 py-3 text-right text-ink-soft select-none">{lines}</pre>
      <textarea
        data-testid={testId}
        className="m-0 min-w-0 flex-1 resize-none rounded-none border-0 bg-transparent p-3 leading-5 whitespace-pre outline-none"
        wrap="off"
        spellCheck={false}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
        }}
      />
    </div>
  );
}
