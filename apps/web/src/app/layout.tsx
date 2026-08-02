import type { Metadata, Viewport } from 'next';
import './globals.css';
import '@timepro/ui/styles.css';

export const metadata: Metadata = {
  title: 'TimePro',
  description: 'TimePro web dashboard',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
