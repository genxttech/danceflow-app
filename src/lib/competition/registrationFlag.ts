// Public competition registration stays off until the owner enables it. The register route 404s when this is
// false, so every link into it must check the same condition.
export function isCompetitionRegistrationEnabled() {
  return process.env.NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED === "true";
}
