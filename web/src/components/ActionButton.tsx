import { useEffect, useRef, useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  /** The action is running somewhere else (screen state), so the button stays locked with the spinner. */
  busy?: boolean;
  /** Shown after the text; the spinner takes its place while the button is locked. */
  icon?: ReactNode;
  /** When it returns a promise, the button stays locked with the spinner until the promise settles. */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => unknown;
};

/** A button that changes state: after a click it blocks more clicks and shows a spinner until the action ends. */
export function ActionButton({ busy = false, icon, onClick, disabled, children, type = 'button', ...rest }: Props) {
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const loading = busy || pending;
  const run = (e: MouseEvent<HTMLButtonElement>) => {
    const result = onClick?.(e) as PromiseLike<unknown> | undefined;
    if (typeof result?.then !== 'function') return;
    setPending(true);
    const done = () => { if (mounted.current) setPending(false); };
    result.then(done, done);
  };
  return (
    <button {...rest} type={type} disabled={disabled || loading} aria-busy={loading || undefined} onClick={run}>
      {children}
      {loading ? <span className="button-spinner" aria-hidden="true" /> : icon}
    </button>
  );
}
