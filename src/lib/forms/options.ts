export type Option = {
  value: string;
  label: string;
};

export const US_STATE_OPTIONS: Option[] = [
  { value: "AL", label: "Alabama" },
  { value: "AK", label: "Alaska" },
  { value: "AZ", label: "Arizona" },
  { value: "AR", label: "Arkansas" },
  { value: "CA", label: "California" },
  { value: "CO", label: "Colorado" },
  { value: "CT", label: "Connecticut" },
  { value: "DE", label: "Delaware" },
  { value: "FL", label: "Florida" },
  { value: "GA", label: "Georgia" },
  { value: "HI", label: "Hawaii" },
  { value: "ID", label: "Idaho" },
  { value: "IL", label: "Illinois" },
  { value: "IN", label: "Indiana" },
  { value: "IA", label: "Iowa" },
  { value: "KS", label: "Kansas" },
  { value: "KY", label: "Kentucky" },
  { value: "LA", label: "Louisiana" },
  { value: "ME", label: "Maine" },
  { value: "MD", label: "Maryland" },
  { value: "MA", label: "Massachusetts" },
  { value: "MI", label: "Michigan" },
  { value: "MN", label: "Minnesota" },
  { value: "MS", label: "Mississippi" },
  { value: "MO", label: "Missouri" },
  { value: "MT", label: "Montana" },
  { value: "NE", label: "Nebraska" },
  { value: "NV", label: "Nevada" },
  { value: "NH", label: "New Hampshire" },
  { value: "NJ", label: "New Jersey" },
  { value: "NM", label: "New Mexico" },
  { value: "NY", label: "New York" },
  { value: "NC", label: "North Carolina" },
  { value: "ND", label: "North Dakota" },
  { value: "OH", label: "Ohio" },
  { value: "OK", label: "Oklahoma" },
  { value: "OR", label: "Oregon" },
  { value: "PA", label: "Pennsylvania" },
  { value: "RI", label: "Rhode Island" },
  { value: "SC", label: "South Carolina" },
  { value: "SD", label: "South Dakota" },
  { value: "TN", label: "Tennessee" },
  { value: "TX", label: "Texas" },
  { value: "UT", label: "Utah" },
  { value: "VT", label: "Vermont" },
  { value: "VA", label: "Virginia" },
  { value: "WA", label: "Washington" },
  { value: "WV", label: "West Virginia" },
  { value: "WI", label: "Wisconsin" },
  { value: "WY", label: "Wyoming" },
  { value: "DC", label: "District of Columbia" },
];

export const TIMEZONE_OPTIONS: Option[] = [
  { value: "America/New_York", label: "Eastern Time (America/New_York)" },
  { value: "America/Chicago", label: "Central Time (America/Chicago)" },
  { value: "America/Denver", label: "Mountain Time (America/Denver)" },
  { value: "America/Phoenix", label: "Arizona Time (America/Phoenix)" },
  { value: "America/Los_Angeles", label: "Pacific Time (America/Los_Angeles)" },
  { value: "America/Anchorage", label: "Alaska Time (America/Anchorage)" },
  { value: "Pacific/Honolulu", label: "Hawaii Time (Pacific/Honolulu)" },
];

export const CLIENT_STATUS_OPTIONS: Option[] = [
  { value: "lead", label: "Lead" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "archived", label: "Archived" },
];

export const CLIENT_SKILL_LEVEL_OPTIONS: Option[] = [
  { value: "beginner", label: "Beginner" },
  { value: "intermediate", label: "Intermediate" },
  { value: "advanced", label: "Advanced" },
  { value: "competitive", label: "Competitive" },
  { value: "professional", label: "Professional" },
];

export const CLIENT_REFERRAL_SOURCE_OPTIONS: Option[] = [
  { value: "manual", label: "Manual" },
  { value: "friend_referral", label: "Friend Referral" },
  { value: "google_search", label: "Google Search" },
  { value: "facebook", label: "Facebook" },
  { value: "instagram", label: "Instagram" },
  { value: "website", label: "Website" },
  { value: "walk_in", label: "Walk-In" },
  { value: "public_intro_booking", label: "Public Intro Booking" },
  { value: "event_registration", label: "Event Registration" },
];

export const EVENT_VISIBILITY_OPTIONS: Option[] = [
  { value: "public", label: "Public" },
  { value: "unlisted", label: "Unlisted" },
  { value: "private", label: "Private" },
];

export const EVENT_STATUS_OPTIONS: Option[] = [
  { value: "draft", label: "Draft" },
  { value: "published", label: "Published" },
  { value: "open", label: "Open" },
  { value: "cancelled", label: "Cancelled" },
  { value: "completed", label: "Completed" },
];

export const EVENT_TYPE_OPTIONS: Option[] = [
  { value: "group_class", label: "Group Class" },
  { value: "practice_party", label: "Practice Party" },
  { value: "workshop", label: "Workshop" },
  { value: "social_dance", label: "Social Dance" },
  { value: "competition", label: "Competition" },
  { value: "showcase", label: "Showcase" },
  { value: "festival", label: "Festival" },
  { value: "special_event", label: "Special Event" },
  { value: "other", label: "Other" },
];

export const APPOINTMENT_TYPE_OPTIONS: Option[] = [
  { value: "private_lesson", label: "Private Lesson" },
  { value: "group_class", label: "Group Class" },
  { value: "intro_lesson", label: "Intro Lesson" },
  { value: "coaching", label: "Coaching" },
  { value: "practice_party", label: "Practice Party" },
  { value: "floor_space_rental", label: "Floor Space Rental" },
  { value: "event", label: "Event" },
];

export const PAYMENT_METHOD_OPTIONS: Option[] = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "check", label: "Check" },
  { value: "bank_transfer", label: "Bank Transfer" },
  { value: "other", label: "Other" },
];

export const PAYMENT_TYPE_OPTIONS: Option[] = [
  { value: "membership", label: "Membership" },
  { value: "package_sale", label: "Package Sale" },
  { value: "event_registration", label: "Event Registration" },
  { value: "floor_rental", label: "Floor Rental" },
  { value: "other", label: "Other" },
];

export const MEMBERSHIP_BILLING_INTERVAL_OPTIONS: Option[] = [
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
];

export function isAllowedOptionValue(options: Option[], value: string) {
  if (!value) return true;
  return options.some((option) => option.value === value);
}

export function normalizeOptionValue(options: Option[], value: string) {
  if (!value) return null;
  return isAllowedOptionValue(options, value) ? value : null;
}