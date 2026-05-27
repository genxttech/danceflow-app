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
      setStatus("Starting camera...");

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

            form?.requestSubmit();
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
        className="rounded-xl border border-[var(--brand-border)] px-3 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-[var(--brand-soft)]"
      >
        Scan QR Code
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4">
          <div className="w-full max-w-md rounded-3xl bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">
                  Scan ticket QR code
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  The QR code will submit into the existing ticket-code check-in flow.
                </p>
              </div>

              <button
                type="button"
                onClick={closeScanner}
                className="rounded-full border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:bg-slate-50"
              >
                Close
              </button>
            </div>

            <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-slate-950">
              <video
                ref={videoRef}
                muted
                playsInline
                className="aspect-square w-full object-cover"
              />
            </div>

            {status ? (
              <p className="mt-3 rounded-2xl bg-slate-50 px-3 py-2 text-sm text-slate-700">
                {status}
              </p>
            ) : null}

            {error ? (
              <p className="mt-3 rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            ) : null}

            <p className="mt-3 text-xs text-slate-500">
              If scanning does not work on this device, type or paste the ticket code into the field instead.
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}
