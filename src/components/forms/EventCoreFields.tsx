import {
  EVENT_STATUS_OPTIONS,
  EVENT_TYPE_OPTIONS,
  EVENT_VISIBILITY_OPTIONS,
  TIMEZONE_OPTIONS,
  US_STATE_OPTIONS,
} from "@/lib/forms/options";

type EventFormValues = {
  name?: string | null;
  slug?: string | null;
  eventType?: string | null;
  shortDescription?: string | null;
  description?: string | null;
  publicSummary?: string | null;
  publicDescription?: string | null;
  venueName?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  timezone?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  visibility?: string | null;
  status?: string | null;
  capacity?: number | null;
};

function toDateInput(value?: string | null) {
  return value ? value.slice(0, 10) : "";
}

export default function EventCoreFields({
  initialValues,
}: {
  initialValues?: EventFormValues;
}) {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="md:col-span-2">
        <label htmlFor="name" className="mb-1 block text-sm font-medium">
          Event Name
        </label>
        <input
          id="name"
          name="name"
          required
          defaultValue={initialValues?.name ?? ""}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        />
      </div>

      <div>
        <label htmlFor="slug" className="mb-1 block text-sm font-medium">
          Slug
        </label>
        <input
          id="slug"
          name="slug"
          defaultValue={initialValues?.slug ?? ""}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        />
      </div>

      <div>
        <label htmlFor="eventType" className="mb-1 block text-sm font-medium">
          Event Type
        </label>
        <select
          id="eventType"
          name="eventType"
          required
          defaultValue={initialValues?.eventType ?? "group_class"}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        >
          {EVENT_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="visibility" className="mb-1 block text-sm font-medium">
          Visibility
        </label>
        <select
          id="visibility"
          name="visibility"
          defaultValue={initialValues?.visibility ?? "private"}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        >
          {EVENT_VISIBILITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="status" className="mb-1 block text-sm font-medium">
          Status
        </label>
        <select
          id="status"
          name="status"
          defaultValue={initialValues?.status ?? "draft"}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        >
          {EVENT_STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
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
          defaultValue={
            initialValues?.capacity == null ? "" : String(initialValues.capacity)
          }
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        />
      </div>

      <div className="md:col-span-2">
        <label htmlFor="shortDescription" className="mb-1 block text-sm font-medium">
          Short Description
        </label>
        <input
          id="shortDescription"
          name="shortDescription"
          defaultValue={initialValues?.shortDescription ?? ""}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        />
      </div>

      <div className="md:col-span-2">
        <label htmlFor="description" className="mb-1 block text-sm font-medium">
          Description
        </label>
        <textarea
          id="description"
          name="description"
          rows={5}
          defaultValue={initialValues?.description ?? ""}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        />
      </div>

      <div className="md:col-span-2">
        <label htmlFor="publicSummary" className="mb-1 block text-sm font-medium">
          Public Summary
        </label>
        <input
          id="publicSummary"
          name="publicSummary"
          defaultValue={initialValues?.publicSummary ?? ""}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        />
      </div>

      <div className="md:col-span-2">
        <label htmlFor="publicDescription" className="mb-1 block text-sm font-medium">
          Public Description
        </label>
        <textarea
          id="publicDescription"
          name="publicDescription"
          rows={5}
          defaultValue={initialValues?.publicDescription ?? ""}
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

      <div className="md:col-span-2">
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

      <div className="md:col-span-2">
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

      <div />
      <div>
        <label htmlFor="startDate" className="mb-1 block text-sm font-medium">
          Start Date
        </label>
        <input
          id="startDate"
          name="startDate"
          type="date"
          defaultValue={toDateInput(initialValues?.startDate)}
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
          defaultValue={toDateInput(initialValues?.endDate)}
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
          defaultValue={initialValues?.startTime ?? ""}
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
          defaultValue={initialValues?.endTime ?? ""}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        />
      </div>
    </div>
  );
}