type GeocodeResult = {
  latitude: number;
  longitude: number;
};

type GoogleGeocodeResponse = {
  status: string;
  results?: Array<{
    geometry?: {
      location?: {
        lat?: number;
        lng?: number;
      };
    };
  }>;
  error_message?: string;
};

export function buildStudioLocationQuery(params: {
  city: string | null;
  state: string | null;
  postalCode: string | null;
}) {
  const parts = [params.city, params.state, params.postalCode]
    .map((value) => value?.trim())
    .filter(Boolean);

  return parts.join(", ");
}

export function buildEventLocationQuery(params: {
  venueName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}) {
  const parts = [
    params.venueName,
    params.addressLine1,
    params.addressLine2,
    params.city,
    params.state,
    params.postalCode,
  ]
    .map((value) => value?.trim())
    .filter(Boolean);

  return parts.join(", ");
}

export async function geocodeAddress(
  address: string
): Promise<GeocodeResult | null> {
  const apiKey = process.env.GOOGLE_MAPS_GEOCODING_API_KEY;

  if (!apiKey || !address.trim()) {
    return null;
  }

  try {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", address);
    url.searchParams.set("key", apiKey);

    const response = await fetch(url.toString(), {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      console.error("Geocoding request failed", {
        status: response.status,
        statusText: response.statusText,
      });
      return null;
    }

    const payload = (await response.json()) as GoogleGeocodeResponse;

    if (payload.status !== "OK") {
      console.error("Geocoding returned non-OK status", {
        status: payload.status,
        message: payload.error_message,
      });
      return null;
    }

    const location = payload.results?.[0]?.geometry?.location;

    if (
      typeof location?.lat !== "number" ||
      typeof location?.lng !== "number"
    ) {
      return null;
    }

    return {
      latitude: location.lat,
      longitude: location.lng,
    };
  } catch (error) {
    console.error("Geocoding failed", error);
    return null;
  }
}
