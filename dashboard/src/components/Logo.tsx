import { useId } from 'react';

/** Roundy: the Roundabout bot mascot. Single color (currentColor); the face is cut out with a mask. */
export default function Logo({ size = 22, className }: { size?: number; className?: string }) {
  const mask = `rb-logo-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false" className={className}>
      <path d="M12.08 20.5A23 23 0 0 1 51.07 19.14" fill="none" stroke="currentColor" strokeWidth="6.5" strokeLinecap="round" /><path d="M53.87 24.89L56.71 15.34L45.43 22.94Z" fill="currentColor" stroke="currentColor" strokeWidth="3.4" strokeLinejoin="round" /><path d="M51.92 43.5A23 23 0 0 1 12.93 44.86" fill="none" stroke="currentColor" strokeWidth="6.5" strokeLinecap="round" /><path d="M10.13 39.11L7.29 48.66L18.57 41.06Z" fill="currentColor" stroke="currentColor" strokeWidth="3.4" strokeLinejoin="round" />
      <defs>
        <mask id={mask}>
          <rect width="64" height="64" fill="#fff" />
          <rect x="25" y="26" width="4.4" height="10" rx="2.2" fill="#000" />
          <rect x="34.6" y="26" width="4.4" height="10" rx="2.2" fill="#000" />
        </mask>
      </defs>
      <g mask={`url(#${mask})`}>
        <circle cx="32" cy="32" r="13.5" fill="currentColor" />
      </g>
    </svg>
  );
}
