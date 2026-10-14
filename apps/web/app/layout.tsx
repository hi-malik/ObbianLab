import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'Obbian Service Desk',
  description: 'Booking workflow demonstration',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
