/** Public storage bucket for event images (cover images). Upload policy: launchsec1b2 public asset storage. */
export const EVENT_IMAGE_BUCKET = "event-media";

/** The bucket's own limit (storage.buckets.file_size_limit); uploads above it are refused by storage. */
export const EVENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The public URL prefix of a studio's event images. A cover image URL is accepted from the Competition Setup
 * Wizard only when it is the event's current cover or lies under this prefix (an upload made for that studio).
 */
export function eventImagePublicPrefix(supabaseUrl: string, studioId: string) {
  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/${EVENT_IMAGE_BUCKET}/${studioId}/`;
}
