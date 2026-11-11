import type { Metadata } from 'next';
import '@fontsource/instrument-sans/latin-400.css';
import '@fontsource/instrument-sans/latin-600.css';
import '@fontsource/instrument-sans/latin-700.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'NEAR PayMandate',
  description: 'Invoice approvals and delegated payments on NEAR Testnet.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
