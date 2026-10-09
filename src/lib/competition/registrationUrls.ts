/**
 * Public competition registration URLs. The cart public token is the buyer's bearer reference;
 * the status page derives everything it shows from server-side order/payment state.
 */
export function competitionRegistrationUrls(origin: string, eventSlug: string, cartToken: string) {
  const base = origin.replace(/\/$/, "");
  const slug = encodeURIComponent(eventSlug);
  const token = encodeURIComponent(cartToken);
  return {
    statusUrl: `${base}/events/${slug}/competition/register/status?token=${token}`,
    cancelUrl: `${base}/api/events/${slug}/competition/release?token=${token}`,
    resumeUrl: `${base}/api/events/${slug}/competition/resume?token=${token}`,
  };
}
