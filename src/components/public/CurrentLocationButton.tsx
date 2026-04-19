"use client";

import { useState } from "react";

type Props = {
  latitudeInputId?: string;
  longitudeInputId?: string;
  modeInputId?: string;
};

export default function CurrentLocationButton({
  latitudeInputId = "search-latitude",
  longitudeInputId = "search-longitude",
  modeInputId = "search-location-mode",
}: Props) {
  const [status, setStatus] = useState<string>("");

  function setInputValue(id: string, value: string) {
    const element = document.getElementById(id) as HTMLInputElement | null;
    if (element) {
      element.value = value;
    }
  }

  function submitParentForm() {
    const latitudeInput = document.getElementById(latitudeInputId) as HTMLInputElement | null;
    const form = latitudeInput?.closest("form");
    if (form) {
      form.requestSubmit();
    }
  }

  function useManualFilters() {
    setInputValue(modeInputId, "manual");
    setInputValue(latitudeInputId, "");
    setInputValue(longitudeInputId, "");
    setStatus("Using manual location filters.");
    submitParentForm();
  }

  function useCurrentLocation() {
    if (!navigator.geolocation) {
      setStatus("Your browser does not support location access.");
      return;
    }

    setStatus("Getting your location...");

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setInputValue(modeInputId, "current");
        setInputValue(latitudeInputId, String(position.coords.latitude));
        setInputValue(longitudeInputId, String(position.coords.longitude));
        setStatus("Using your current location.");
        submitParentForm();
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          setStatus("Location permission was denied.");
          return;
        }

        if (error.code === error.POSITION_UNAVAILABLE) {
          setStatus("Your location is unavailable right now.");
          return;
        }

        if (error.code === error.TIMEOUT) {
          setStatus("Location request timed out.");
          return;
        }

        setStatus("Could not get your location.");
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 300000,
      }
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={useCurrentLocation}
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Use my current location
        </button>

        <button
          type="button"
          onClick={useManualFilters}
          className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
        >
          Use manual filters
        </button>
      </div>

      {status ? <p className="text-xs text-slate-500">{status}</p> : null}
    </div>
  );
}