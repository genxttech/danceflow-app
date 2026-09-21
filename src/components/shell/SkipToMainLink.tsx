/**
 * "Skip to main content" link shared by the public, studio-app, platform and portal shells.
 * Visually hidden until it receives keyboard focus; targets `#main-content`.
 */
export default function SkipToMainLink() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[100] focus:rounded-xl focus:bg-[var(--brand-primary)] focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white focus:shadow-lg focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-white"
    >
      Skip to main content
    </a>
  );
}
