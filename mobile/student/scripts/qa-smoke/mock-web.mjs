// QA-only stand-in for the DanceFlow web API (never committed). Serves just enough for signed-in Student screens.
import http from "node:http";

const STUDIO = { linkId: "l1", clientId: "22222222-2222-4222-8222-222222222222", studioId: "11111111-1111-4111-8111-111111111111", studioSlug: "qa-dance-studio", studioName: "QA Dance Studio", studioPublicName: null, clientFirstName: "Dana", clientLastName: "Dancer", clientEmail: "dana.dancer@example.test", clientPhone: null, isIndependentInstructor: false, lumiEnabled: !!process.env.QA_LUMI_ENABLED, status: "linked", relationshipType: "self" };
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    console.log(new Date().toISOString(), req.method, url.pathname);
    if (url.pathname === "/api/student/studio-links")
      return json(res, 200, { hasPortalAccess: true, linkedStudios: [STUDIO], primaryStudio: STUDIO, lumiEnabled: !!process.env.QA_LUMI_ENABLED });
    if (url.pathname === "/api/student/profile")
      return json(res, 200, {
        profile: {
          userId: "00000000-0000-4000-8000-000000000000", firstName: "Dana", lastName: "Dancer", preferredName: "Dana",
          email: "dana.dancer@example.test", phone: "", birthday: "", photoUrl: "", addressLine1: "", addressLine2: "",
          city: "", state: "", postalCode: "", country: "US", danceInterests: "Salsa", danceGoals: [], skillLevel: "",
          bio: "", profileVisibility: "private",
        },
      });
    if (url.pathname === "/api/stripe/client-checkout") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<h1>QA checkout</h1><p>Mock payment page for "+url.searchParams.get("paymentId")+"</p>"); }
    if (url.pathname === "/api/tickets/qr") { // a 1x1 PNG stands in for the QR image
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    }
    // PR 650 shape: admissions left per ticket type, counted server-side. A limited ticket (3 of 10 left) so the event screen shows "3 admission spots left".
    if (/^\/api\/student\/events\/[0-9a-f-]{36}\/availability$/.test(url.pathname))
      return json(res, 200, { eventId: url.pathname.split("/")[4], tickets: [{ ticketTypeId: "55555555-5555-4555-8555-555555555551", capacity: 10, remaining: 3, soldOut: false }] });
    // Fictional paid order for the ended event "QA Ended Last Week" (run.mjs --past-events). A fixture only: no database row, no payment provider.
    if (url.pathname === "/api/student/events/orders/99999999-9999-4999-8999-999999999991")
      return json(res, 200, { orderId: "99999999-9999-4999-8999-999999999991", eventId: "44444444-4444-4444-8444-4444444444a1", eventName: "QA Ended Last Week", eventSlug: "qa-ended-last-week", status: "paid", paymentStatus: "paid", currency: "usd", totalAmount: 25, paidAt: new Date(Date.now() - 9 * 86400000).toISOString(), cancelledAt: null, expiresAt: null, registrationIds: ["66666666-6666-4666-8666-666666666681"], ticketCount: 1, ticketCodesIssued: 1, ticketsReady: true, tickets: [] });
    return json(res, 404, { error: "not mocked" });
  })
  .listen(8791, "0.0.0.0", () => console.log("mock web on 8791"));
