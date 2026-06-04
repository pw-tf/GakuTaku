import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost';
  size?: 'sm';
}

export function Btn({ variant = 'default', size, className = '', children, ...rest }: BtnProps) {
  const cn = [
    'btn',
    variant === 'primary' && 'btn-primary',
    variant === 'ghost' && 'btn-ghost',
    size === 'sm' && 'btn-sm',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button className={cn} {...rest}>
      {children}
    </button>
  );
}

export function Chip({
  accent,
  children,
  className = '',
}: {
  accent?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={['chip', accent && 'accent', className].filter(Boolean).join(' ')}>
      {children}
    </span>
  );
}

export function Kicker({
  accent,
  children,
  style,
}: {
  accent?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <span className={'kicker' + (accent ? ' accent' : '')} style={style}>
      {children}
    </span>
  );
}
