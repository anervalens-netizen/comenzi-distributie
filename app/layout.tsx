import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import './combined-cart-fix.css';
import { PwaInstall } from '@/components/pwa';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Mobiup · Comenzi & avize',
  description: 'Comenzi accesorii, standuri și avize SIM 0 pentru echipa de distribuție.',
  icons: { icon: '/icons/icon-192.png', apple: '/icons/icon-192.png' },
};
export const viewport: Viewport = {width:'device-width',initialScale:1,themeColor:'#e52430',viewportFit:'cover'};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ro">
      <head><link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" /></head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        <PwaInstall />
      </body>
    </html>
  );
}
