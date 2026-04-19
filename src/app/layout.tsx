import "./globals.css";
import Link from "next/link";

export const metadata = {
  title: "DanceFlow",
  description: "Dance studio CRM, scheduler, events manager",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-slate-900">
        <div className="flex min-h-screen flex-col">
          <main className="flex-1">{children}</main>

          <footer className="border-t border-slate-200 bg-white">
            <div className="mx-auto flex max-w-7xl flex-col gap-3 px-6 py-6 text-sm text-slate-600 md:flex-row md:items-center md:justify-between">
              <p>© {new Date().getFullYear()} DanceFlow. All rights reserved.</p>

              <div className="flex flex-wrap items-center gap-4">
                <Link
                  href="/privacy-policy"
                  className="transition hover:text-slate-900"
                >
                  Privacy Policy
                </Link>

                <Link
                  href="/terms-and-conditions"
                  className="transition hover:text-slate-900"
                >
                  Terms & Conditions
                </Link>
              </div>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}