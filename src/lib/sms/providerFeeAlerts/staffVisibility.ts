/**
 * Admin-addressed RFL alert emails (template keys starting `platform_rfl_admin_`) are platform exceptions: studio staff must never read their recipient,
 * subject or template. The database hides them with RLS; the Communications page also excludes them from every list and count it builds.
 */
export const RFL_ADMIN_TEMPLATE_PREFIX = "platform_rfl_admin_";

/** PostgREST `or` filter keeping rows with no template key or a key that is not admin-addressed RFL mail (a plain `not like` would drop NULL keys). */
export const STAFF_VISIBLE_DELIVERY_OR_FILTER = `template_key.is.null,template_key.not.like.${RFL_ADMIN_TEMPLATE_PREFIX}*`;

export const isStaffVisibleDeliveryTemplate = (templateKey: string | null | undefined) => !(templateKey ?? "").startsWith(RFL_ADMIN_TEMPLATE_PREFIX);
