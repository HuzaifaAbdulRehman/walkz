import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Walkz review dashboard',
  description: 'Evidence-first pull request reviews.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
