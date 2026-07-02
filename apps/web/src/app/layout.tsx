import type { Metadata } from 'next';
import './globals.css';
import '@timepro/ui/styles.css';

export const metadata: Metadata = {
  title: 'TimePro',
  description: 'TimePro web dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
