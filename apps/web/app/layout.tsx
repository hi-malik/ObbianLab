import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'Zara AI | ObbianLab',
  description: 'Chat with Zara AI, explore ideas and book services with explicit confirmation.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
