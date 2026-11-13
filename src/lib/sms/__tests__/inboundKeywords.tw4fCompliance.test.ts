import { describe, expect, it } from "vitest";
import { classifyInboundKeywordBody, resolveInboundKeyword } from "@/lib/sms/inboundKeywords";

/** TW-4F compliance hardening: opt-out / help keyword tolerance (case, whitespace, trailing punctuation). */
describe("fallback keyword classification tolerates case, whitespace and trailing punctuation", () => {
  const stopVariants = [
    "STOP", "stop", "Stop", "  stop \n", "\tSTOP\r\n", " STOP ", "STOP.", "stop!", "Stop.  ", "STOP!!",
    "\"STOP\"", "\"STOP .\"", "STOP  .", "STOP	!", "END.", "Quit!", "UNSUBSCRIBE.", "stopall",
  ];
  it.each(stopVariants)("%j is an opt-out", (body) => {
    expect(classifyInboundKeywordBody(body)).toBe("stop");
    expect(resolveInboundKeyword({ body })).toEqual({ keyword: "stop", twilioHandled: false });
  });

  it.each(["HELP", "help?", "Help.", "  info! "])("%j is HELP", (body) => {
    expect(classifyInboundKeywordBody(body)).toBe("help");
  });

  it.each(["START", "start", " Yes ", "UNSTOP", "unstop"])("%j is an opt-in", (body) => {
    expect(classifyInboundKeywordBody(body)).toBe("start");
  });

  // a question mark makes it a question, not an unsubscribe ("Cancel?" is a reply to an appointment text)
  it.each(["Cancel?", "CANCEL?", "End?", "stop?", "STOP?", "quit??"])("%j is an ordinary message", (body) => {
    expect(classifyInboundKeywordBody(body)).toBe("message");
  });

  // an opt-in is never inferred from punctuation-decorated chatter: a re-subscribe must be deliberate
  it.each(["yes!", "Yes.", "start.", "yes please"])("%j is NOT an opt-in", (body) => {
    expect(classifyInboundKeywordBody(body)).toBe("message");
  });

  it.each(["please stop", "STOP NOW", "stop, thanks", "stop texting me", "", "   ", "...", "stopping by at 5"])(
    "%j is an ordinary message",
    (body) => {
      expect(classifyInboundKeywordBody(body)).toBe("message");
    },
  );
});
