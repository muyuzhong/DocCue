import type { ReactNode } from 'react';
import { DocCue } from './doccue';

export const metadata = { title: 'Teamspace · Members', icons: { icon: 'data:,' } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ font: '15px/1.5 system-ui, sans-serif', margin: 0, color: '#1e293b', background: '#f8fafc' }}>
        {children}
        <DocCue />
      </body>
    </html>
  );
}
