import type { SelectHTMLAttributes } from 'react';
import { Icon } from './Icons.js';

/** The browser's select with its own arrow drawn inside the padding, so it never touches the border. */
export function Select({ wrapperClassName = '', className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { wrapperClassName?: string }) {
  return (
    <span className={`relative block min-w-0 [&_svg]:pointer-events-none [&_svg]:absolute [&_svg]:top-1/2 [&_svg]:right-3 [&_svg]:-translate-y-1/2 [&_svg]:text-ink-faint ${wrapperClassName}`}>
      <select className={`w-full min-w-0 flex-none appearance-none pr-9 ${className}`} {...props}>{children}</select>
      <Icon name="chevron" size={16} />
    </span>
  );
}
