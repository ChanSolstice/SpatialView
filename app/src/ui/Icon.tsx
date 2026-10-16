/** 图标（前端UI设计 3.4）：24 × 24 网格，2 像素描边，圆角端点，不填充，颜色跟随文字色。 */
import type { ReactNode } from 'react'

const PATHS = {
  scan: (
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16" />
  ),
  select: (
    <>
      <path d="M6 3.5l13 7.2-5.6 1.6-2.2 5.6z" />
      <path d="M13.5 12.5l4.5 4.5" />
    </>
  ),
  plan: (
    <>
      <circle cx="6" cy="18.5" r="2" />
      <circle cx="18" cy="5.5" r="2" />
      <path d="M8 18.5h7.5a3.25 3.25 0 0 0 0-6.5h-7a3.25 3.25 0 0 1 0-6.5H16" />
    </>
  ),
  anim: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5l5.5 3.5-5.5 3.5z" />
    </>
  ),
  play: <path d="M7.5 4.8l11.5 7.2-11.5 7.2z" />,
  pause: <path d="M8.5 5v14M15.5 5v14" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" />,
  laser: (
    <>
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 3v3.2M12 17.8V21M3 12h3.2M17.8 12H21M5.6 5.6l2.3 2.3M16.1 16.1l2.3 2.3M18.4 5.6l-2.3 2.3M7.9 16.1l-2.3 2.3" />
    </>
  ),
  estop: (
    <>
      <path d="M8.4 2.5h7.2l5.9 5.9v7.2l-5.9 5.9H8.4l-5.9-5.9V8.4z" />
      <path d="M12 7.5v6M12 16.6v.1" />
    </>
  ),
  power: (
    <>
      <path d="M12 3.5v8" />
      <path d="M7.2 6.2a7.5 7.5 0 1 0 9.6 0" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11.5a8 8 0 1 0-2.3 6" />
      <path d="M20 4.5v7h-7" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16.5v-5.5a6 6 0 1 1 12 0v5.5l1.8 1.8H4.2z" />
      <path d="M10 21a2 2 0 0 0 4 0" />
    </>
  ),
  down: <path d="M6 9l6 6 6-6" />,
  up: <path d="M6 15l6-6 6 6" />,
  view: (
    <>
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="1.6" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
    </>
  ),
  cube: (
    <>
      <path d="M12 2.5l8.5 4.8v9.4L12 21.5l-8.5-4.8V7.3z" />
      <path d="M12 21.5V12M20.5 7.3L12 12 3.5 7.3" />
    </>
  ),
  wifiOff: (
    <path d="M2.5 8.8a14 14 0 0 1 4.6-2.7M10.5 5.1A14 14 0 0 1 21.5 8.8M5.8 12.2a9 9 0 0 1 3.4-1.9M14.2 10.4a9 9 0 0 1 4 1.8M9 15.6a4.5 4.5 0 0 1 6 0M12 19h.01M3 3l18 18" />
  ),
  warn: (
    <>
      <path d="M12 3.5l9.5 16.5h-19z" />
      <path d="M12 10v4.5M12 17.2v.1" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.6v.1" />
    </>
  ),
  replay: (
    <>
      <path d="M4 12.5a8 8 0 1 0 2.3-6" />
      <path d="M4 4.5v6h6" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  clear: <path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13" />,
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof PATHS

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className ? `ic ${className}` : 'ic'} viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[name]}
    </svg>
  )
}
