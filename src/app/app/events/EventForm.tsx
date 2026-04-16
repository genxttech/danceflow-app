"use client";

import Link from "next/link";
import { useActionState, useEffect, useMemo, useState } from "react";
import { createEventAction, updateEventAction } from "./actions";
import {
  EVENT_STATUS_OPTIONS,
  EVENT_TYPE_OPTIONS,
  EVENT_VISIBILITY_OPTIONS,
  TIMEZONE_OPTIONS,
  US_STATE_OPTIONS,
} from "@/lib/forms/options";

type OrganizerOption = {
  id: string;
  name: string;
  active: boolean;
};

type EventFormValues = {
  id?: string;
  organizerId?: string;
  name?: string;
  slug?: string;
  eventType?: string;
  shortDescription?: string;
  description?: string;
  venueName?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  timezone?: string;
  startDate?: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  coverImageUrl?: string;
  visibility?: string;
  status?: string;
  featured?: boolean;
  beginnerFriendly?: boolean;
  publicDirectoryEnabled?: boolean;
  registrationRequired?: boolean;
  accountRequiredForRegistration?: boolean;
  registrationOpensAt?: string;
  registrationClosesAt?: string;
  capacity?: string;
  waitlistEnabled?: boolean;
  refundPolicy?: string;
  faq?: string;
  tags?: string;
  styleKeys?: string[];
};

type ActionState = {
  error: string;
};

const initialState: ActionState = {
  error: "",
};

const STYLE_OPTIONS = [
  { key: "country", label: "Country" },
  { key: "ballroom", label: "Ballroom" },
  { key: "latin", label: "Latin" },
  { key: "salsa", label: "Salsa" },
  { key: "bachata", label: "Bachata" },
  { key: "swing", label: "Swing" },
  { key: "west_coast_swing", label: "West Coast Swing" },
  { key: "hip_hop", label: "Hip Hop" },
  { key: "contemporary", label: "Contemporary" },
  { key: "ballet", label: "Ballet" },
] as const;

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getLocalDateTimeInputValue() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = `${now.getMonth() + 1}`.padStart(2, "0");
  const dd = `${now.getDate()}`.padStart(2, "0");
  const hh = `${now.getHours()}`.padStart(2, "0");
  const mi = `${now.getMinutes()}`.padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function getTodayDateValue() {
  return getLocalDateTimeInputValue().slice(0, 10);
}

function getCurrentTimeValue() {
  return getLocalDateTimeInputValue().slice(11, 16);
}

function getEventTypeHelpText(value: string) {
  const option = EVENT_TYPE_OPTIONS.find((item) => item.value === value);

  if (!option) {
    return "Choose the event category that best matches this offering.";
  }

  if (value === "group_class") {
    return "Create a class offering as an event. Use this for public, unlisted, or private classes with enrollment and roster management.";
  }

  if (value === "practice_party") {
    return "Social practice or party offering with roster and attendance.";
  }

  if (value === "workshop") {
    return "Special training, bootcamp, or focused educational session.";
  }

  if (value === "social_dance") {
    return "Dance social or community event.";
  }

  if (value === "competition") {
    return "Competitive event, contest, or judged outing.";
  }

  if (value === "showcase") {
    return "Performance, exhibition, or demo event.";
  }

  if (value === "festival") {
    return "Multi-part or larger-format event experience.";
  }

  if (value === "special_event") {
    return "Anything unique that does not fit the standard categories.";
  }

  return "Fallback type for custom use cases.";
}

function getVisibilityHelpText(value: string) {
  if (value === "public") {
    return "Show in public offerings and public event discovery.";
  }

  if (value === "unlisted") {
    return "Hidden from public listings but available by direct link.";
  }

  if (value === "private") {
    return "Internal or invite-only. Not shown publicly.";
  }

  return "Choose who should be able to discover this event.";
}

function getStatusHelpText(value: string) {
  if (value === "draft") {
    return "Still being prepared. Keep hidden until ready.";
  }

  if (value === "published") {
    return "Ready for normal public or internal use.";
  }

  if (value === "open") {
    return "Published and actively open for registration.";
  }

  if (value === "cancelled") {
    return "No longer active. Use when the event will not happen.";
  }

  if (value === "completed") {
    return "Finished event. Keep for history and reporting.";
  }

  return "Choose the current lifecycle status.";
}

export default function EventForm({
  organizers,
  mode = "create",
  initialValues,
}: {
  organizers: OrganizerOption[];
  mode?: "create" | "edit";
  initialValues?: EventFormValues;
}) {
  const action = mode === "edit" ? updateEventAction : createEventAction;
  const [state, formAction, pending] = useActionState(action, initialState);

  const [name, setName] = useState(initialValues?.name ?? "");
  const [slug, setSlug] = useState(initialValues?.slug ?? "");
  const [eventType, setEventType] = useState(initialValues?.eventType ?? "group_class");
  const [visibility, setVisibility] = useState(initialValues?.visibility ?? "public");
  const [status, setStatus] = useState(initialValues?.status ?? "draft");
  const [publicDirectoryEnabled, setPublicDirectoryEnabled] = useState(
    initialValues?.publicDirectoryEnabled ?? false
  );
  const [beginnerFriendly, setBeginnerFriendly] = useState(
    initialValues?.beginnerFriendly ?? false
  );
  const [registrationRequired, setRegistrationRequired] = useState(
    initialValues?.registrationRequired ?? true
  );
  const [accountRequiredForRegistration, setAccountRequiredForRegistration] = useState(
    initialValues?.accountRequiredForRegistration ?? true
  );
  const [waitlistEnabled, setWaitlistEnabled] = useState(
    initialValues?.waitlistEnabled ?? false
  );
  const [capacity, setCapacity] = useState(initialValues?.capacity ?? "");
  const [tags, setTags] = useState(initialValues?.tags ?? "");
  const [startTime, setStartTime] = useState(
    initialValues?.startTime ?? getCurrentTimeValue()
  );
  const [endTime, setEndTime] = useState(initialValues?.endTime ?? "");
  const [selectedStyleKeys, setSelectedStyleKeys] = useState<string[]>(
    initialValues?.styleKeys ?? []
  );

  const suggestedSlug = useMemo(() => slugify(name), [name]);
  const isGroupClass = eventType === "group_class";
  const isPrivateVisibility = visibility === "private";
  const isUnlistedVisibility = visibility === "unlisted";
  const isPublicVisibility = visibility === "public";
  const hasCapacity = capacity.trim() !== "" && Number(capacity) > 0;

  useEffect(() => {
    if (!isGroupClass) return;

    if (!tags.trim()) {
      setTags("group class");
    }

    if (!capacity.trim()) {
      setCapacity("20");
    }

    if (!startTime) {
      setStartTime("19:00");
    }

    if (!endTime) {
      setEndTime("20:00");
    }
  }, [isGroupClass, tags, capacity, startTime, endTime]);

  useEffect(() => {
    if (!isGroupClass) return;

    if (isPrivateVisibility) {
      setRegistrationRequired(true);
    }
  }, [isGroupClass, isPrivateVisibility]);

  useEffect(() => {
    if (!hasCapacity && waitlistEnabled) {
      setWaitlistEnabled(false);
    }
  }, [hasCapacity, waitlistEnabled]);

  useEffect(() => {
    if (publicDirectoryEnabled && visibility !== "public") {
      setVisibility("public");
    }
  }, [publicDirectoryEnabled, visibility]);

  const visibilitySummary = useMemo(() => {
    if (publicDirectoryEnabled) {
      return "This event is eligible for the public dance directory and will be forced to public visibility when saved.";
    }

    if (isGroupClass && isPublicVisibility) {
      return "This class will appear in public offerings and public event discovery.";
    }

    if (isGroupClass && isUnlistedVisibility) {
      return "This class will stay off public listings, but anyone with the direct link can view it.";
    }

    if (isGroupClass && isPrivateVisibility) {
      return "This class will be internal or invite-only and hidden from public discovery.";
    }

    return getVisibilityHelpText(visibility);
  }, [
    publicDirectoryEnabled,
    isGroupClass,
    isPublicVisibility,
    isUnlistedVisibility,
    isPrivateVisibility,
    visibility,
  ]);

  function toggleStyleKey(styleKey: string, checked: boolean) {
    setSelectedStyleKeys((current) => {
      if (checked) {
        return current.includes(styleKey) ? current : [...current, styleKey];
      }
      return current.filter((key) => key !== styleKey);
    });
  }

  return (
    <form action={formAction} className="space-y-8 rounded-2xl border bg-white p-6">
      {mode === "edit" && initialValues?.id ? (
        <input type="hidden" name="id" value={initialValues.id} />
      ) : null}

      <input
        type="hidden"
        name="waitlistEnabled"
        value={waitlistEnabled ? "true" : "false"}
      />

      <div className="rounded-2xl border bg-slate-50 p-5">
        <h3 className="text-lg font-semibold text-slate-900">Event Setup</h3>
        <p className="mt-2 text-sm text-slate-600">
          Use events for public or internal offerings like group classes, practice parties,
          workshops, socials, and special studio events. Visibility controls whether the
          offering appears in public listings.
        </p>
      </div>

      {isGroupClass ? (
        <div className="rounded-2xl border border-green-200 bg-green-50 p-5">
          <h3 className="text-lg font-semibold text-green-900">Group Class Mode</h3>
          <p className="mt-2 text-sm text-green-800">
            Group classes are created here as events, not as standard appointments.
            After creation, the class can be published publicly, shared by unlisted link,
            or kept private for internal scheduling and roster management.
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="name" className="mb-1 block text-sm font-medium">
            Event Name
          </label>
          <input
            id="name"
            name="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder={isGroupClass ? "Beginner Two Step Class" : "Event name"}
          />
        </div>

        <div>
          <label htmlFor="slug" className="mb-1 block text-sm font-medium">
            Slug
          </label>
          <input
            id="slug"
            name="slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder={suggestedSlug || "generated-from-name"}
          />
          <p className="mt-1 text-xs text-slate-500">
            Leave blank to use: {suggestedSlug || "generated-from-name"}
          </p>
        </div>

        <div>
          <label htmlFor="organizerId" className="mb-1 block text-sm font-medium">
            Organizer
          </label>
          <select
            id="organizerId"
            name="organizerId"
            required
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
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
          <label htmlFor="eventType" className="mb-1 block text-sm font-medium">
            Event Type
          </label>
          <select
            id="eventType"
            name="eventType"
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
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
          <label htmlFor="status" className="mb-1 block text-sm font-medium">
            Status
          </label>
          <select
            id="status"
            name="status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
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
          <label htmlFor="visibility" className="mb-1 block text-sm font-medium">
            Visibility
          </label>
          <select
            id="visibility"
            name="visibility"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value)}
            disabled={publicDirectoryEnabled}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-100"
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
          <label htmlFor="startDate" className="mb-1 block text-sm font-medium">
            Start Date
          </label>
          <input
            id="startDate"
            name="startDate"
            type="date"
            required
            defaultValue={initialValues?.startDate ?? getTodayDateValue()}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="endDate" className="mb-1 block text-sm font-medium">
            End Date
          </label>
          <input
            id="endDate"
            name="endDate"
            type="date"
            required
            defaultValue={initialValues?.endDate ?? getTodayDateValue()}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="startTime" className="mb-1 block text-sm font-medium">
            Start Time
          </label>
          <input
            id="startTime"
            name="startTime"
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="endTime" className="mb-1 block text-sm font-medium">
            End Time
          </label>
          <input
            id="endTime"
            name="endTime"
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="venueName" className="mb-1 block text-sm font-medium">
            Venue Name
          </label>
          <input
            id="venueName"
            name="venueName"
            defaultValue={initialValues?.venueName ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder={isGroupClass ? "Main Studio" : "Studio / Hotel / Ballroom / Venue"}
          />
        </div>

        <div>
          <label htmlFor="timezone" className="mb-1 block text-sm font-medium">
            Time Zone
          </label>
          <select
            id="timezone"
            name="timezone"
            defaultValue={initialValues?.timezone ?? "America/New_York"}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            {TIMEZONE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="addressLine1" className="mb-1 block text-sm font-medium">
            Address Line 1
          </label>
          <input
            id="addressLine1"
            name="addressLine1"
            defaultValue={initialValues?.addressLine1 ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="addressLine2" className="mb-1 block text-sm font-medium">
            Address Line 2
          </label>
          <input
            id="addressLine2"
            name="addressLine2"
            defaultValue={initialValues?.addressLine2 ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="city" className="mb-1 block text-sm font-medium">
            City
          </label>
          <input
            id="city"
            name="city"
            defaultValue={initialValues?.city ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="state" className="mb-1 block text-sm font-medium">
            State
          </label>
          <select
            id="state"
            name="state"
            defaultValue={initialValues?.state ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
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
          <label htmlFor="postalCode" className="mb-1 block text-sm font-medium">
            Postal Code
          </label>
          <input
            id="postalCode"
            name="postalCode"
            defaultValue={initialValues?.postalCode ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="coverImageFile" className="mb-1 block text-sm font-medium">
            Cover Image Upload
          </label>
          <input
            id="coverImageFile"
            name="coverImageFile"
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/webp"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
          <p className="mt-1 text-xs text-slate-500">
            Upload a JPG, PNG, or WEBP image. Recommended for the public event page and discovery cards.
          </p>
        </div>

        <div>
          <label htmlFor="coverImageUrl" className="mb-1 block text-sm font-medium">
            Cover Image URL
          </label>
          <input
            id="coverImageUrl"
            name="coverImageUrl"
            defaultValue={initialValues?.coverImageUrl ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder="Optional fallback URL"
          />
          <p className="mt-1 text-xs text-slate-500">
            Optional advanced fallback. If you upload a file, the upload will be used instead.
          </p>
        </div>

        <div>
          <label htmlFor="capacity" className="mb-1 block text-sm font-medium">
            Capacity
          </label>
          <input
            id="capacity"
            name="capacity"
            type="number"
            min="0"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder={isGroupClass ? "20" : "Optional"}
          />
        </div>

        <div>
          <label htmlFor="tags" className="mb-1 block text-sm font-medium">
            Tags
          </label>
          <input
            id="tags"
            name="tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
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

      <div>
        <label htmlFor="shortDescription" className="mb-1 block text-sm font-medium">
          Public Summary
        </label>
        <textarea
          id="shortDescription"
          name="shortDescription"
          rows={3}
          defaultValue={initialValues?.shortDescription ?? ""}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
          placeholder={
            isGroupClass
              ? "Short summary for the class card and public event directory."
              : "Short summary for public event cards and discovery pages."
          }
        />
      </div>

      <div>
        <label htmlFor="description" className="mb-1 block text-sm font-medium">
          Public Description
        </label>
        <textarea
          id="description"
          name="description"
          rows={6}
          defaultValue={initialValues?.description ?? ""}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
          placeholder={
            isGroupClass
              ? "Describe the class level, style, what students should expect, and any dress or partner requirements."
              : "Full public event description, schedule notes, what to expect, and important details."
          }
        />
      </div>

      <div className="rounded-2xl border border-orange-200 bg-orange-50 p-5">
        <h3 className="text-lg font-semibold text-orange-900">Public Discovery</h3>
        <p className="mt-2 text-sm text-orange-800">
          Use these settings to control whether this organizer event appears in the public dance directory.
        </p>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="flex items-start gap-3 rounded-xl border bg-white p-4">
            <input
              type="checkbox"
              name="publicDirectoryEnabled"
              checked={publicDirectoryEnabled}
              onChange={(e) => setPublicDirectoryEnabled(e.target.checked)}
              className="mt-1"
            />
            <div>
              <p className="font-medium text-slate-900">Show in public dance directory</p>
              <p className="mt-1 text-sm text-slate-600">
                Only organizer-published events with this enabled will appear in public event discovery.
              </p>
            </div>
          </label>

          <label className="flex items-start gap-3 rounded-xl border bg-white p-4">
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
      </div>

      <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
        <h3 className="text-lg font-semibold text-sky-900">Dance Styles</h3>
        <p className="mt-2 text-sm text-sky-800">
          Assign styles so dancers can find this event in public search filters.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
                <span className="text-sm font-medium text-slate-800">{style.label}</span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
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

      {isGroupClass ? (
        <div className="rounded-2xl border border-blue-200 bg-blue-50 p-5 text-sm text-blue-900">
          <p className="font-medium">Group class publishing model</p>
          <ul className="mt-2 space-y-1 text-blue-800">
            <li>Public classes can appear in offerings and event discovery.</li>
            <li>Unlisted classes stay hidden from listings but can be shared directly.</li>
            <li>Private classes are internal or invite-only and not shown publicly.</li>
          </ul>
        </div>
      ) : null}

      {publicDirectoryEnabled ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-900">
          <p className="font-medium">Public directory enabled</p>
          <p className="mt-2 text-emerald-800">
            This event will be eligible for the public dance directory when saved with a public host studio, active organizer, and published/open status.
          </p>
        </div>
      ) : null}

      {waitlistEnabled ? (
        <div className="rounded-2xl border border-purple-200 bg-purple-50 p-5 text-sm text-purple-900">
          <p className="font-medium">Waitlist is enabled</p>
          <p className="mt-2 text-purple-800">
            When this event sells out, new registrants will be added to the waitlist and will not
            be charged until staff promotes them.
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label
            htmlFor="registrationOpensAt"
            className="mb-1 block text-sm font-medium"
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
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label
            htmlFor="registrationClosesAt"
            className="mb-1 block text-sm font-medium"
          >
            Registration Closes At
          </label>
          <input
            id="registrationClosesAt"
            name="registrationClosesAt"
            type="datetime-local"
            defaultValue={initialValues?.registrationClosesAt ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>
      </div>

      <div>
        <label htmlFor="refundPolicy" className="mb-1 block text-sm font-medium">
          Refund Policy
        </label>
        <textarea
          id="refundPolicy"
          name="refundPolicy"
          rows={4}
          defaultValue={initialValues?.refundPolicy ?? ""}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
          placeholder="Optional refund policy text."
        />
      </div>

      <div>
        <label htmlFor="faq" className="mb-1 block text-sm font-medium">
          FAQ
        </label>
        <textarea
          id="faq"
          name="faq"
          rows={4}
          defaultValue={initialValues?.faq ?? ""}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
          placeholder="Optional FAQ text."
        />
      </div>

      {state.error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.error}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800 disabled:opacity-60"
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
          className="rounded-xl border px-4 py-2 hover:bg-slate-50"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}