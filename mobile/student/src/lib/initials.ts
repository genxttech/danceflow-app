/** Up to two initials for the profile button: names first, else the email's first letter. */
export function initialsFor(name: string, email?: string | null) {
  const words = name.trim().split(/\s+/).filter((word) => word && !word.includes("@"));
  const letters = words.slice(0, 2).map((word) => word[0]!.toUpperCase()).join("");
  return letters || (email?.trim()[0]?.toUpperCase() ?? "D");
}
