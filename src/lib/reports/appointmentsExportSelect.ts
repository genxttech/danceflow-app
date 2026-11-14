/**
 * The appointments CSV export's select. `appointments` has two foreign keys to `clients` (client_id, partner_client_id), so the client embed must name its
 * relationship: a bare `clients ( ... )` embed is rejected by PostgREST with PGRST201 on every request. The alias keeps the result key `clients`.
 * Kept here, outside the route file, so a real-PostgREST test can run this exact string.
 */
export const APPOINTMENTS_EXPORT_SELECT = `
      title,
      appointment_type,
      status,
      starts_at,
      ends_at,
      notes,
      clients:clients!appointments_client_id_fkey ( first_name, last_name ),
      instructors ( first_name, last_name ),
      rooms ( name )
    `;
