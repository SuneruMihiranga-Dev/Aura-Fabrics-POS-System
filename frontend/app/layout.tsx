import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aura Fabrics | Point of Sale",
  description: "Sales, payments, stock and receipts for Aura Fabrics.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
