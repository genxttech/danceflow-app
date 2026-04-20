"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { createEventAction, updateEventAction } from "./actions";

type OrganizerOption = {
  id: string;
  name: string;
};

type EventFormState = {
  error?: string;
  success?: string;
};

type EventFormInitialValues = {
  id?: string;
  name?: string;
  slug?: string;
  organizerId?: string;
  eventType?: string;
  status?: string;
  visibility?: string;
  startDate?: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  timezone?: string;
  venueName?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  coverImageUrl?: string;
  shortDescription?: string;
  description?: string;
  refundPolicy?: string;
  faq?: string;
  tags?: string;
  capacity?: number | null;
  featured?: boolean;
  registrationRequired?: boolean;
  accountRequiredForRegistration?: boolean;
  waitlistEnabled?: boolean;
  registrationOpensAt?: string;
  registrationClosesAt?: string;
  publicDirectoryEnabled?: boolean;
  beginnerFriendly?: boolean;
  styleKeys?: string[];
};

type EventFormProps = {
  mode: "create" | "edit";
  organizers: OrganizerOption[];
  initialValues?: EventFormInitialValues;
};

const EVENT_TYPE_OPTIONS = [
  { value: "group_class", label: "Group Class" },
  { value: "social_dance", label: "Social Dance" },
  { value: "workshop", label: "Workshop" },
  { value: "party", label: "Party" },
  { value: "competition", label: "Competition" },
  { value: "showcase", label: "Showcase" },
  { value: "festival", label: "Festival" },
  { value: "special_event", label: "Special Event" },
  { value: "other", label: "Other" },
] as const;

const EVENT_STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "published", label: "Published" },
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "cancelled", label: "Cancelled" },
] as const;

const EVENT_VISIBILITY_OPTIONS = [
  { value: "private", label: "Private" },
  { value: "unlisted", label: "Unlisted" },
  { value: "public", label: "Public" },
] as const;

const STYLE_OPTIONS = [
  { key: "ballroom", label: "Ballroom" },
  { key: "latin", label: "Latin" },
  { key: "country", label: "Country" },
  { key: "swing", label: "Swing" },
  { key: "salsa", label: "Salsa" },
  { key: "bachata", label: "Bachata" },
  { key: "west_coast_swing", label: "West Coast Swing" },
  { key: "line_dance", label: "Line Dance" },
  { key: "nightclub_two_step", label: "Nightclub Two Step" },
] as const;

const TIMEZONE_OPTIONS = [
  { value: "America/New_York", label: "Eastern Time" },
  { value: "America/Chicago", label: "Central Time" },
  { value: "America/Denver", label: "Mountain Time" },
  { value: "America/Los_Angeles", label: "Pacific Time" },
] as const;

const US_STATE_OPTIONS = [
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
];

const initialState: EventFormState = {
  error: "",
  success: "",
};

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getTodayDateValue() {
  return new Date().toISOString().slice(0, 10);
}

function getLocalDateTimeInputValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function getEventTypeHelpText(eventType: string) {
  switch (eventType) {
    case "group_class":
      return "Best for classes that may be public, private, or unlisted and can support registration.";
    case "social_dance":
      return "Best for dance nights, open socials, and community gatherings.";
    case "workshop":
      return "Best for educational intensives, seminars, and focused training blocks.";
    case "competition":
      return "Best for competitive events, heats, and judged formats.";
    default:
      return "Choose the closest event category for search and reporting.";
  }
}

function getStatusHelpText(status: string) {
  switch (status) {
    case "draft":
      return "Visible only internally until you are ready to publish.";
    case "published":
      return "Published and ready to appear where allowed by visibility.";
    case "open":
      return "Published and actively open for registration.";
    case "closed":
      return "Not accepting new registrations.";
    case "cancelled":
      return "Cancelled and should no longer be promoted.";
    default:
      return "";
  }
}

export default function EventForm({
  mode,
  organizers,
  initialValues,
}: EventFormProps) {
  const action = mode === "edit" ? updateEventAction : createEventAction;
  const [state, formAction, pending] = useActionState(action, initialState);

  const [name, setName] = useState(initialValues?.name ?? "");
  const [slug, setSlug] = useState(initialValues?.slug ?? "");
  const [eventType, setEventType] = useState(initialValues?.eventType ?? "group_class");
  const [status, setStatus] = useState(initialValues?.status ?? "draft");
  const [visibility, setVisibility] = useState(initialValues?.visibility ?? "private");
  const [capacity, setCapacity] = useState(
    initialValues?.capacity != null ? String(initialValues.capacity) : ""
  );
  const [registrationRequired, setRegistrationRequired] = useState(
    initialValues?.registrationRequired ?? true
  );
  const [accountRequiredForRegistration, setAccountRequiredForRegistration] = useState(
    initialValues?.accountRequiredForRegistration ?? false
  );
  const [waitlistEnabled, setWaitlistEnabled] = useState(
    initialValues?.waitlistEnabled ?? false
  );
  const [publicDirectoryEnabled, setPublicDirectoryEnabled] = useState(
    initialValues?.publicDirectoryEnabled ?? false
  );
  const [beginnerFriendly, setBeginnerFriendly] = useState(
    initialValues?.beginnerFriendly ?? false
  );
  const [selectedStyleKeys, setSelectedStyleKeys] = useState<string[]>(
    initialValues?.styleKeys ?? []
  );
  const [tags, setTags] = useState(initialValues?.tags ?? "");
  const [startTime, setStartTime] = useState(initialValues?.startTime ?? "");
  const [endTime, setEndTime] = useState(initialValues?.endTime ?? "");

  const suggestedSlug = useMemo(() => slugify(name), [name]);
  const isGroupClass = eventType === "group_class";
  const hasCapacity = capacity.trim() !== "" && Number(capacity) > 0;

  const visibilitySummary = useMemo(() => {
    if (publicDirectoryEnabled) {
      return "Public directory enabled overrides visibility to make the event discoverable.";
    }

    switch (visibility) {
      case "public":
        return "Public pages can show this event when organizer and publication rules allow it.";
      case "unlisted":
        return "The event can be shared by direct link but is not listed in discovery.";
      default:
        return "Private events stay internal and out of public discovery.";
    }
  }, [publicDirectoryEnabled, visibility]);

  function toggleStyleKey(styleKey: string, checked: boolean) {
    setSelectedStyleKeys((current) =>
      checked
        ? Array.from(new Set([...current, styleKey]))
        : current.filter((item) => item !== styleKey)
    );
  }

  return (
    <form action={formAction} className="space-y-5 md:space-y-6">
      {mode === "edit" && initialValues?.id ? (
        <input type="hidden" name="id" value={initialValues.id} />
      ) : null}

      <input
        type="hidden"
        name="waitlistEnabled"
        value={waitlistEnabled ? "true" : "false"}
      />

      {selectedStyleKeys.map((styleKey) => (
        <input key={styleKey} type="hidden" name="styleKeys" value={styleKey} />
      ))}

      <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-slate-900 md:text-3xl">
              {mode === "edit" ? "Edit Event" : "New Event"}
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600 md:text-base">
              Create public or internal offerings like group classes, socials,
              workshops, and special events. The mobile layout is tightened for
              faster organizer and studio workflow.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:min-w-[280px]">
            <button
              type="submit"
              disabled={pending}
              className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {pending
                ? mode === "edit"
                  ? "Saving..."
                  : "Creating..."
                : mode === "edit"
                ? "Save Event"
                : "Create Event"}
            </button>

            <Link
              href={
                mode === "edit" && initialValues?.id
                  ? `/app/events/${initialValues.id}`
                  : "/app/events"
              }
              className="inline-flex items-center justify-center rounded-xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </Link>
          </div>
        </div>

        {state.error ? (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {state.error}
          </div>
        ) : null}
      </div>

      {state.success ? (
  <div className="mt-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
    {state.success}
  </div>
) : null}

      <div className="grid gap-5 xl:grid-cols-[1.08fr_0.92fr] xl:items-start">
        <div className="space-y-5">
          <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
            <div className="mb-4">
              <h3 className="text-lg font-semibold text-slate-900 md:text-xl">
                Core Setup
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Define the event identity, schedule, organizer, and location.
              </p>
            </div>

            {isGroupClass ? (
              <div className="mb-4 rounded-2xl border border-green-200 bg-green-50 p-4">
                <h4 className="text-base font-semibold text-green-900">
                  Group Class Mode
                </h4>
                <p className="mt-2 text-sm text-green-800">
                  Group classes are created here as events, not as standard
                  appointments. After creation, the class can be published publicly,
                  shared by unlisted link, or kept private for internal scheduling
                  and roster management.
                </p>
              </div>
            ) : null}

            <div className="grid gap-4 md:grid-cols-2">
              <div className="md:col-span-2">
                <label htmlFor="name" className="mb-1.5 block text-sm font-medium">
                  Event Name
                </label>
                <input
                  id="name"
                  name="name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder={isGroupClass ? "Beginner Two Step Class" : "Event name"}
                />
              </div>

              <div>
                <label htmlFor="slug" className="mb-1.5 block text-sm font-medium">
                  Slug
                </label>
                <input
                  id="slug"
                  name="slug"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder={suggestedSlug || "generated-from-name"}
                />
                <p className="mt-1 text-xs text-slate-500">
                  Leave blank to use: {suggestedSlug || "generated-from-name"}
                </p>
              </div>

              <div>
                <label htmlFor="organizerId" className="mb-1.5 block text-sm font-medium">
                  Organizer
                </label>
                <select
                  id="organizerId"
                  name="organizerId"
                  required
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  defaultValue={initialValues?.organizerId ?? ""}
                >
                  <option value="">Select organizer</option>
                  {organizers.map((organizer) => (
                    <option key={organizer.id} value={organizer.id}>
                      {organizer.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="eventType" className="mb-1.5 block text-sm font-medium">
                  Event Type
                </label>
                <select
                  id="eventType"
                  name="eventType"
                  value={eventType}
                  onChange={(e) => setEventType(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                >
                  {EVENT_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-slate-500">
                  {getEventTypeHelpText(eventType)}
                </p>
              </div>

              <div>
                <label htmlFor="status" className="mb-1.5 block text-sm font-medium">
                  Status
                </label>
                <select
                  id="status"
                  name="status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                >
                  {EVENT_STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-slate-500">
                  {getStatusHelpText(status)}
                </p>
              </div>

              <div>
                <label htmlFor="visibility" className="mb-1.5 block text-sm font-medium">
                  Visibility
                </label>
                <select
                  id="visibility"
                  name="visibility"
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value)}
                  disabled={publicDirectoryEnabled}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm disabled:bg-slate-100"
                >
                  {EVENT_VISIBILITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-slate-500">{visibilitySummary}</p>
              </div>

              <div>
                <label htmlFor="startDate" className="mb-1.5 block text-sm font-medium">
                  Start Date
                </label>
                <input
                  id="startDate"
                  name="startDate"
                  type="date"
                  required
                  defaultValue={initialValues?.startDate ?? getTodayDateValue()}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                />
              </div>

              <div>
                <label htmlFor="endDate" className="mb-1.5 block text-sm font-medium">
                  End Date
                </label>
                <input
                  id="endDate"
                  name="endDate"
                  type="date"
                  required
                  defaultValue={initialValues?.endDate ?? getTodayDateValue()}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                />
              </div>

              <div>
                <label htmlFor="startTime" className="mb-1.5 block text-sm font-medium">
                  Start Time
                </label>
                <input
                  id="startTime"
                  name="startTime"
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                />
              </div>

              <div>
                <label htmlFor="endTime" className="mb-1.5 block text-sm font-medium">
                  End Time
                </label>
                <input
                  id="endTime"
                  name="endTime"
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                />
              </div>

              <div>
                <label htmlFor="venueName" className="mb-1.5 block text-sm font-medium">
                  Venue Name
                </label>
                <input
                  id="venueName"
                  name="venueName"
                  defaultValue={initialValues?.venueName ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder={isGroupClass ? "Main Studio" : "Studio / Hotel / Ballroom / Venue"}
                />
              </div>

              <div>
                <label htmlFor="timezone" className="mb-1.5 block text-sm font-medium">
                  Time Zone
                </label>
                <select
                  id="timezone"
                  name="timezone"
                  defaultValue={initialValues?.timezone ?? "America/New_York"}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                >
                  {TIMEZONE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="addressLine1" className="mb-1.5 block text-sm font-medium">
                  Address Line 1
                </label>
                <input
                  id="addressLine1"
                  name="addressLine1"
                  defaultValue={initialValues?.addressLine1 ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                />
              </div>

              <div>
                <label htmlFor="addressLine2" className="mb-1.5 block text-sm font-medium">
                  Address Line 2
                </label>
                <input
                  id="addressLine2"
                  name="addressLine2"
                  defaultValue={initialValues?.addressLine2 ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                />
              </div>

              <div>
                <label htmlFor="city" className="mb-1.5 block text-sm font-medium">
                  City
                </label>
                <input
                  id="city"
                  name="city"
                  defaultValue={initialValues?.city ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                />
              </div>

              <div>
                <label htmlFor="state" className="mb-1.5 block text-sm font-medium">
                  State
                </label>
                <select
                  id="state"
                  name="state"
                  defaultValue={initialValues?.state ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                >
                  <option value="">Select state</option>
                  {US_STATE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="postalCode" className="mb-1.5 block text-sm font-medium">
                  Postal Code
                </label>
                <input
                  id="postalCode"
                  name="postalCode"
                  defaultValue={initialValues?.postalCode ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                />
              </div>

              <div>
                <label htmlFor="coverImageFile" className="mb-1.5 block text-sm font-medium">
                  Cover Image Upload
                </label>
                <input
                  id="coverImageFile"
                  name="coverImageFile"
                  type="file"
                  accept="image/png,image/jpeg,image/jpg,image/webp"
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                />
                <p className="mt-1 text-xs text-slate-500">
                  Upload a JPG, PNG, or WEBP image. Recommended for the public event page and discovery cards.
                </p>
              </div>

              <div>
                <label htmlFor="coverImageUrl" className="mb-1.5 block text-sm font-medium">
                  Cover Image URL
                </label>
                <input
                  id="coverImageUrl"
                  name="coverImageUrl"
                  defaultValue={initialValues?.coverImageUrl ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder="Optional fallback URL"
                />
                <p className="mt-1 text-xs text-slate-500">
                  Optional advanced fallback. If you upload a file, the upload will be used instead.
                </p>
              </div>

              <div>
                <label htmlFor="capacity" className="mb-1.5 block text-sm font-medium">
                  Capacity
                </label>
                <input
                  id="capacity"
                  name="capacity"
                  type="number"
                  min="0"
                  value={capacity}
                  onChange={(e) => setCapacity(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder={isGroupClass ? "20" : "Optional"}
                />
              </div>

              <div>
                <label htmlFor="tags" className="mb-1.5 block text-sm font-medium">
                  Tags
                </label>
                <input
                  id="tags"
                  name="tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder={
                    isGroupClass
                      ? "group class, beginner, country, ballroom"
                      : "beginner, country, ballroom, members"
                  }
                />
                <p className="mt-1 text-xs text-slate-500">
                  Comma-separated tags for discovery and filtering.
                </p>
              </div>
            </div>
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
            <div className="mb-4">
              <h3 className="text-lg font-semibold text-slate-900 md:text-xl">
                Public Content
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Control the event copy shown on discovery cards and the public event page.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label
                  htmlFor="shortDescription"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Public Summary
                </label>
                <textarea
                  id="shortDescription"
                  name="shortDescription"
                  rows={3}
                  defaultValue={initialValues?.shortDescription ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder={
                    isGroupClass
                      ? "Short summary for the class card and public event directory."
                      : "Short summary for public event cards and discovery pages."
                  }
                />
              </div>

              <div>
                <label htmlFor="description" className="mb-1.5 block text-sm font-medium">
                  Public Description
                </label>
                <textarea
                  id="description"
                  name="description"
                  rows={6}
                  defaultValue={initialValues?.description ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder={
                    isGroupClass
                      ? "Describe the class level, style, what students should expect, and any dress or partner requirements."
                      : "Full public event description, schedule notes, what to expect, and important details."
                  }
                />
              </div>

              <div>
                <label htmlFor="refundPolicy" className="mb-1.5 block text-sm font-medium">
                  Refund Policy
                </label>
                <textarea
                  id="refundPolicy"
                  name="refundPolicy"
                  rows={4}
                  defaultValue={initialValues?.refundPolicy ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder="Optional refund policy text."
                />
              </div>

              <div>
                <label htmlFor="faq" className="mb-1.5 block text-sm font-medium">
                  FAQ
                </label>
                <textarea
                  id="faq"
                  name="faq"
                  rows={4}
                  defaultValue={initialValues?.faq ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder="Optional FAQ text."
                />
              </div>
            </div>
          </section>
        </div>

        <div className="space-y-5 xl:sticky xl:top-6">
          <section className="rounded-3xl border border-orange-200 bg-orange-50 p-4 shadow-sm md:p-6">
            <h3 className="text-lg font-semibold text-orange-900">
              Public Discovery
            </h3>
            <p className="mt-2 text-sm text-orange-800">
              Use these settings to control whether this organizer event appears in the public dance directory.
            </p>

            <div className="mt-4 space-y-3">
              <label className="flex items-start gap-3 rounded-xl border border-orange-200 bg-white p-4">
                <input
                  type="checkbox"
                  name="publicDirectoryEnabled"
                  checked={publicDirectoryEnabled}
                  onChange={(e) => setPublicDirectoryEnabled(e.target.checked)}
                  className="mt-1"
                />
                <div>
                  <p className="font-medium text-slate-900">
                    Show in public dance directory
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Only organizer-published events with this enabled will appear in public event discovery.
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-3 rounded-xl border border-orange-200 bg-white p-4">
                <input
                  type="checkbox"
                  name="beginnerFriendly"
                  checked={beginnerFriendly}
                  onChange={(e) => setBeginnerFriendly(e.target.checked)}
                  className="mt-1"
                />
                <div>
                  <p className="font-medium text-slate-900">Beginner-friendly</p>
                  <p className="mt-1 text-sm text-slate-600">
                    Add a beginner-friendly badge in public event discovery.
                  </p>
                </div>
              </label>
            </div>
          </section>

          <section className="rounded-3xl border border-sky-200 bg-sky-50 p-4 shadow-sm md:p-6">
            <h3 className="text-lg font-semibold text-sky-900">Dance Styles</h3>
            <p className="mt-2 text-sm text-sky-800">
              Assign styles so dancers can find this event in public search filters.
            </p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {STYLE_OPTIONS.map((style) => {
                const checked = selectedStyleKeys.includes(style.key);

                return (
                  <label
                    key={style.key}
                    className="flex items-center gap-3 rounded-xl border bg-white p-3"
                  >
                    <input
                      type="checkbox"
                      name="styleKeys"
                      value={style.key}
                      checked={checked}
                      onChange={(e) => toggleStyleKey(style.key, e.target.checked)}
                      className="h-4 w-4"
                    />
                    <span className="text-sm font-medium text-slate-800">
                      {style.label}
                    </span>
                  </label>
                );
              })}
            </div>
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
            <h3 className="text-lg font-semibold text-slate-900 md:text-xl">
              Registration & Access
            </h3>
            <p className="mt-2 text-sm text-slate-600">
              Control enrollment behavior, waitlist access, and registration timing.
            </p>

            <div className="mt-4 space-y-3">
              <label className="flex items-start gap-3 rounded-xl border bg-slate-50 p-4">
                <input
                  type="checkbox"
                  name="featured"
                  defaultChecked={initialValues?.featured ?? false}
                  className="mt-1"
                />
                <div>
                  <p className="font-medium text-slate-900">Featured event</p>
                  <p className="mt-1 text-sm text-slate-600">
                    Featured events can be promoted higher in public listings later.
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-3 rounded-xl border bg-slate-50 p-4">
                <input
                  type="checkbox"
                  name="registrationRequired"
                  checked={registrationRequired}
                  onChange={(e) => setRegistrationRequired(e.target.checked)}
                  className="mt-1"
                />
                <div>
                  <p className="font-medium text-slate-900">Registration required</p>
                  <p className="mt-1 text-sm text-slate-600">
                    Turn this on for offerings that should manage enrollment, roster, and attendance through event registration.
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-3 rounded-xl border bg-slate-50 p-4">
                <input
                  type="checkbox"
                  name="accountRequiredForRegistration"
                  checked={accountRequiredForRegistration}
                  onChange={(e) => setAccountRequiredForRegistration(e.target.checked)}
                  className="mt-1"
                />
                <div>
                  <p className="font-medium text-slate-900">
                    Account required for registration
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Require a signed-in account before someone can register or enroll.
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-3 rounded-xl border bg-slate-50 p-4">
                <input
                  type="checkbox"
                  checked={waitlistEnabled}
                  onChange={(e) => setWaitlistEnabled(e.target.checked)}
                  disabled={!hasCapacity}
                  className="mt-1"
                />
                <div>
                  <p className="font-medium text-slate-900">Enable waitlist</p>
                  <p className="mt-1 text-sm text-slate-600">
                    When capacity is full, new registrants can join the waitlist instead of being blocked.
                  </p>
                  {!hasCapacity ? (
                    <p className="mt-2 text-xs text-slate-500">
                      Add a capacity limit to use waitlist mode.
                    </p>
                  ) : null}
                </div>
              </label>
            </div>

            <div className="mt-4 grid gap-4">
              <div>
                <label
                  htmlFor="registrationOpensAt"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Registration Opens At
                </label>
                <input
                  id="registrationOpensAt"
                  name="registrationOpensAt"
                  type="datetime-local"
                  defaultValue={
                    initialValues?.registrationOpensAt ?? getLocalDateTimeInputValue()
                  }
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                />
              </div>

              <div>
                <label
                  htmlFor="registrationClosesAt"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Registration Closes At
                </label>
                <input
                  id="registrationClosesAt"
                  name="registrationClosesAt"
                  type="datetime-local"
                  defaultValue={initialValues?.registrationClosesAt ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                />
              </div>
            </div>
          </section>

          {isGroupClass ? (
            <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
              <p className="font-medium">Group class publishing model</p>
              <ul className="mt-2 space-y-1 text-blue-800">
                <li>• Public classes can appear in offerings and event discovery.</li>
                <li>• Unlisted classes stay hidden from listings but can be shared directly.</li>
                <li>• Private classes are internal or invite-only and not shown publicly.</li>
              </ul>
            </div>
          ) : null}

          {publicDirectoryEnabled ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              <p className="font-medium">Public directory enabled</p>
              <p className="mt-2 text-emerald-800">
                This event will be eligible for the public dance directory when saved with a public host studio, active organizer, and published/open status.
              </p>
            </div>
          ) : null}

          {waitlistEnabled ? (
            <div className="rounded-2xl border border-purple-200 bg-purple-50 p-4 text-sm text-purple-900">
              <p className="font-medium">Waitlist is enabled</p>
              <p className="mt-2 text-purple-800">
                When this event sells out, new registrants will be added to the waitlist and will not
                be charged until staff promotes them.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </form>
  );
}