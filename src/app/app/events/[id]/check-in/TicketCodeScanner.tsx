"use client";

import { useEffect, useRef, useState } from "react";

type BarcodeResult = {
  rawValue?: string;
};

type BarcodeDetectorInstance = {
  detect: (source: CanvasImageSource) => Promise<BarcodeResult[]>;
};

type BarcodeDetectorConstructor = new (options?: {
  formats?: string[];
}) => BarcodeDetectorInstance;

type WindowWithBarcodeDetector = Window & {
  BarcodeDetector?: BarcodeDetectorConstructor;
};

type TicketCodeScannerProps = {
  inputId: string;
};

function normalizeTicketCode(value: string) {
  return value.trim().toUpperCase();
}

function isTicketCode(value: string) {
  return /^DF-[A-Z0-9-]{6,80}$/.test(normalizeTicketCode(value));
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

export default function TicketCodeScanner({ inputId }: TicketCodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<number | null>(null);

  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    async function startScanner() {
      setError("");
      setStatus("Starting camera…");

      const Detector = (window as WindowWithBarcodeDetector).BarcodeDetector;

      if (!Detector) {
        setError(
          "QR scanning is not supported in this browser. Use the ticket-code field instead.",
        );
        setStatus("");
        return;
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        setError(
          "Camera access is not available in this browser. Use the ticket-code field instead.",
        );
        setStatus("");
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
          },
          audio: false,
        });

        if (cancelled) {
          stopStream(stream);
          return;
        }

        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        const detector = new Detector({ formats: ["qr_code"] });

        setStatus("Point the camera at the ticket QR code.");

        intervalRef.current = window.setInterval(async () => {
          const video = videoRef.current;

          if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            return;
          }

          try {
            const results = await detector.detect(video);
            const scannedValue = normalizeTicketCode(
              results.find((result) => result.rawValue)?.rawValue ?? "",
            );

            if (!scannedValue) return;

            if (!isTicketCode(scannedValue)) {
              setStatus("QR code found, but it does not look like a DanceFlow ticket code.");
              return;
            }

            const input = document.getElementById(inputId) as HTMLInputElement | null;

            if (!input) {
              setError("Ticket-code field was not found. Enter the code manually.");
              return;
            }

            input.value = scannedValue;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));

            const form = input.closest("form");

            setStatus(`Scanned ${scannedValue}. Checking in...`);

            if (intervalRef.current) {
              window.clearInterval(intervalRef.current);
              intervalRef.current = null;
            }

            stopStream(streamRef.current);
            streamRef.current = null;
            setOpen(false);

            // Defer submission one tick so the input/change events finish
            // propagating before the server action receives the form data.
            window.setTimeout(() => {
              form?.requestSubmit();
            }, 0);
          } catch {
            // Keep scanning. Some frames fail when the QR code is not fully visible.
          }
        }, 450);
      } catch {
        setError(
          "Could not start the camera. Check browser permissions or enter the ticket code manually.",
        );
        setStatus("");
      }
    }

    startScanner();

    return () => {
      cancelled = true;

      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }

      stopStream(streamRef.current);
      streamRef.current = null;
    };
  }, [inputId, open]);

  function closeScanner() {
    setOpen(false);
    setError("");
    setStatus("");

    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    stopStream(streamRef.current);
    streamRef.current = null;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm font-semibold text-[var(--brand-primary)] shadow-sm transition hover:bg-[var(--brand-primary-soft)]"
      >
        Scan QR code
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md overflow-hidden rounded-[28px] border border-white/20 bg-white shadow-2xl">
            <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] p-5 text-white"><div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  Scan ticket QR code
                </h2>
                <p className="mt-1 text-sm leading-6 text-white/75">
                  The QR code will submit into the existing ticket-code check-in flow.
                </p>
              </div>

              <button
                type="button"
                onClick={closeScanner}
                className="rounded-full border border-white/20 bg-white/10 px-3 py-1 text-sm text-white hover:bg-white/15"
              >
                Close
              </button>
            </div></div>

            <div className="m-5 overflow-hidden rounded-2xl border border-slate-200 bg-slate-950">
              <video
                ref={videoRef}
                muted
                playsInline
                className="aspect-square w-full object-cover"
              />
            </div>

            {status ? (
              <p className="mx-5 mt-3 rounded-2xl bg-[var(--brand-primary-soft)] px-3 py-2 text-sm text-slate-700">
                {status}
              </p>
            ) : null}

            {error ? (
              <p className="mx-5 mt-3 rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            ) : null}

            <p className="m-5 mt-3 text-xs leading-5 text-slate-500">
              If scanning does not work on this device, type or paste the ticket code into the field instead.
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}
