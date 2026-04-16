import "./globals.css";

export const metadata = {
  title: "StudioFlow",
  description: "Dance studio CRM and scheduler",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}