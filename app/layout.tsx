import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Mira's Kitchen Bot",
  description: "Backend service for Mira's Kitchen Telegram bot.",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
