/** Thin-stroke (1.6px) icon set, ported from the design handoff (gt-core.jsx). */
import type { SVGProps } from 'react';

interface IconProps {
  s?: number;
  w?: number;
}

function svg(paths: string[]) {
  return function IconComponent({ s = 20, w = 1.6, ...rest }: IconProps & SVGProps<SVGSVGElement>) {
    return (
      <svg
        width={s}
        height={s}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={w}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ display: 'block', flex: 'none' }}
        {...rest}
      >
        {paths.map((d, i) => (
          <path d={d} key={i} />
        ))}
      </svg>
    );
  };
}

export const Icon = {
  library: svg([
    'M4 5.5A1.5 1.5 0 0 1 5.5 4H9v16H5.5A1.5 1.5 0 0 1 4 18.5z',
    'M9 4h4.5A1.5 1.5 0 0 1 15 5.5v13A1.5 1.5 0 0 1 13.5 20H9',
    'M16 6l3.2-.6a1 1 0 0 1 1.2.8l2.2 12a1 1 0 0 1-.8 1.2L18 20',
  ]),
  reader: svg([
    'M12 6c-2-1.4-4.5-2-7-2v14c2.5 0 5 .6 7 2',
    'M12 6c2-1.4 4.5-2 7-2v14c-2.5 0-5 .6-7 2z',
    'M12 6v14',
  ]),
  review: svg([
    'M3 8.5 11.3 4a1.4 1.4 0 0 1 1.4 0L21 8.5l-8.3 4.5a1.4 1.4 0 0 1-1.4 0z',
    'M3 13.5 11.3 18a1.4 1.4 0 0 0 1.4 0L21 13.5',
  ]),
  decks: svg(['M4 5h7v6H4z', 'M13 5h7v6h-7z', 'M4 13h7v6H4z', 'M13 13h7v6h-7z']),
  chart: svg(['M4 20V4', 'M4 20h16', 'M8 16v-4', 'M12.5 16V8', 'M17 16v-7']),
  search: svg(['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14', 'M20 20l-4-4']),
  plus: svg(['M12 5v14', 'M5 12h14']),
  sun: svg([
    'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10',
    'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19',
  ]),
  menu: svg(['M4 7h16M4 12h16M4 17h16']),
  study: svg(['M4 6h11M4 12h11M4 18h7', 'M18.5 14.5l2 2 3-3.5']),
  vertical: svg(['M9 4v16', 'M15 4v16', 'M9 8h6M9 13h6']),
  horizontal: svg(['M4 9h16', 'M4 15h16', 'M8 9v6M16 9v6']),
  close: svg(['M6 6l12 12M18 6 6 18']),
  undo: svg(['M8 5 4 9l4 4', 'M4 9h10a5 5 0 1 1 0 10h-4']),
  chevR: svg(['M9 5l7 7-7 7']),
  chevL: svg(['M15 5l-7 7 7 7']),
  sound: svg(['M4 9v6h4l5 4V5L8 9z', 'M16 9a3 3 0 0 1 0 6', 'M18.5 7a6 6 0 0 1 0 10']),
  star: svg(['M12 4l2.3 5 5.2.5-3.9 3.5 1.2 5.2L12 20.8 7.2 23.7l1.2-5.2-3.9-3.5 5.2-.5z']),
  rss: svg(['M5 18a1 1 0 1 0 0 2 1 1 0 0 0 0-2', 'M5 12a7 7 0 0 1 7 7', 'M5 6a13 13 0 0 1 13 13']),
  flame: svg(['M12 3c1 3-1.5 4-1.5 6.5a3 3 0 0 0 6 .5c0-1 .5-1.5.5-1.5 1 1.5 2 3 2 5.5a7 7 0 1 1-14 0C5.5 9 9 7 12 3z']),
  check: svg(['M5 12.5 10 17 19 7']),
  trash: svg(['M4 7h16', 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2', 'M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13', 'M10 11v6M14 11v6']),
  upload: svg(['M12 16V5', 'M8 9l4-4 4 4', 'M5 19h14']),
  gear: svg([
    'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
    'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  ]),
};

export type IconName = keyof typeof Icon;
