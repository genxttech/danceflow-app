"use client";

import { useActionState, useMemo, useState } from "react";
import { createAppointmentAction } from "../actions";
import { summarizeClientPackageItems } from "@/lib/utils/packageSummary";

const initialState = { error: "" };

type ClientOption = {
  id: string;
  first_name: string;
  last_name: string;
  status?: string | null;
};

type InstructorOption = {
  id: string;
  first_name: string;
  last_name: string;
};

type RoomOption = {
  id: string;
  name: string;
};

type ClientPackageItem = {
  usage_type: string;
  quantity_remaining: number | null;
  quantity_total?: number | null;
  is_unlimited: boolean;
};

type ClientPackageOption = {
  id: string;
  client_id: string;
  name_snapshot: string;
  active: boolean;
  expiration_date?: string | null;
  client_package_items: ClientPackageItem[];
};

type MembershipBenefit = {
  benefit_type: string;
  quantity: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
  usage_period: string;
  applies_to: string | null;
};

type ClientMembershipOption = {
  id: string;
  client_id: string;
  status: string;
  starts_on: string;
  ends_on: string | null;
  current_period_start: string;
  current_period_end: string;
  auto_renew: boolean;
  cancel_at_period_end: boolean;
  name_snapshot: string;
  price_snapshot: number;
  billing_interval_snapshot: string;
  benefits: MembershipBenefit[];
};

type FloorRentalSlot = {
  date: string;
  startTime: string;
  endTime: string;
};

type PackageHealth =
  | "healthy"
  | "low_balance"
  | "depleted"
  | "inactive"
  | "expired"
  | "unknown";

function getLowestRemainingValue(items: ClientPackageItem[]) {
  const finiteItems = items.filter(
    (item) => !item.is_unlimited && typeof item.quantity_remaining === "number"
  );

  if (finiteItems.length === 0) return null;

  return Math.min(...finiteItems.map((item) => Number(item.quantity_remaining ?? 0)));
}

function getPackageHealth(pkg: ClientPackageOption | null): PackageHealth {
  if (!pkg) return "unknown";
  if (!pkg.active) return "inactive";

  if (pkg.expiration_date) {
    const expiration = new Date(pkg.expiration_date);
    const now = new Date();
    if (expiration < now) return "expired";
  }

  const lowestRemaining = getLowestRemainingValue(pkg.client_package_items);

  if (lowestRemaining === null) return "healthy";
  if (lowestRemaining <= 0) return "depleted";
  if (lowestRemaining === 1) return "low_balance";

  return "healthy";
}

function packageHealthLabel(health: PackageHealth) {
  if (health === "healthy") return "Active";
  if (health === "low_balance") return "Low Balance";
  if (health === "depleted") return "Depleted";
  if (health === "inactive") return "Inactive";
  if (health === "expired") return "Expired";
  return "Unknown";
}

function packageHealthClass(health: PackageHealth) {
  if (health === "healthy") return "bg-green-50 text-green-700";
  if (health === "low_balance") return "bg-amber-50 text-amber-700";
  if (health === "depleted") return "bg-red-50 text-red-700";
  if (health === "inactive" || health === "expired") {
    return "bg-slate-100 text-slate-700";
  }
  return "bg-slate-100 text-slate-700";
}

function packageWarningMessage(health: PackageHealth) {
  if (health === "inactive") return "Linked package is inactive.";
  if (health === "expired") return "Linked package is expired.";
  if (health === "depleted") return "Linked package has no remaining balance.";
  if (health === "low_balance") return "Linked package is running low.";
  return "";
}

function appointmentTypeLabel(value: string) {
  if (value === "private_lesson") return "Private Lesson";
  if (value === "group_class") return "Group Class";
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "coaching") return "Coaching";
  if (value === "practice_party") return "Practice Party";
  if (value === "event") return "Event";
  if (value === "floor_space_rental") return "Floor Space Rental";
  return value.replaceAll("_", " ");
}

function formatCurrency(value: number | null) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value ?? 0));
}

function paymentStatusLabel(value: string) {
  if (value === "unpaid") return "Unpaid";
  if (value === "partial") return "Partially Paid";
  if (value === "paid") return "Paid";
  if (value === "waived") return "Waived";
  if (value === "refunded") return "Refunded";
  return value.replaceAll("_", " ");
}

function formatShortDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}

function billingIntervalLabel(value: string) {
  if (value === "monthly") return "Monthly";
  if (value === "quarterly") return "Quarterly";
  if (value === "yearly") return "Yearly";
  return value;
}

function usagePeriodLabel(value: string) {
  if (value === "billing_cycle") return "Per Billing Cycle";
  if (value === "monthly") return "Per Month";
  if (value === "unlimited") return "Unlimited";
  return value;
}

function benefitTypeLabel(value: string) {
  if (value === "unlimited_group_classes") return "Unlimited Group Classes";
  if (value === "unlimited_practice_parties") return "Unlimited Practice Parties";
  if (value === "included_private_lessons") return "Included Private Lessons";
  if (value === "event_discount_percent") return "Event Discount Percent";
  if (value === "floor_rental_discount_percent") return "Floor Rental Discount Percent";
  return value.replaceAll("_", " ");
}

function getBenefitAppliesToAppointmentType(
  benefit: MembershipBenefit,
  appointmentType: string
) {
  if (benefit.benefit_type === "included_private_lessons") {
    return appointmentType === "private_lesson";
  }

  if (benefit.benefit_type === "unlimited_group_classes") {
    return appointmentType === "group_class";
  }

  if (benefit.benefit_type === "unlimited_practice_parties") {
    return appointmentType === "practice_party";
  }

  if (benefit.benefit_type === "floor_rental_discount_percent") {
    return appointmentType === "floor_space_rental";
  }

  return false;
}

function membershipBenefitSummary(
  benefit: MembershipBenefit,
  appointmentType: string
) {
  const applies = getBenefitAppliesToAppointmentType(benefit, appointmentType);

  if (benefit.benefit_type === "included_private_lessons") {
    return {
      applies,
      text:
        benefit.quantity != null
          ? `${benefit.quantity} included • ${usagePeriodLabel(benefit.usage_period)}`
          : `Included • ${usagePeriodLabel(benefit.usage_period)}`,
    };
  }

  if (benefit.benefit_type === "unlimited_group_classes") {
    return {
      applies,
      text: `Unlimited group classes • ${usagePeriodLabel(benefit.usage_period)}`,
    };
  }

  if (benefit.benefit_type === "unlimited_practice_parties") {
    return {
      applies,
      text: `Unlimited practice parties • ${usagePeriodLabel(benefit.usage_period)}`,
    };
  }

  if (benefit.benefit_type === "floor_rental_discount_percent") {
    const discount =
      benefit.discount_percent != null
        ? `${benefit.discount_percent}% discount`
        : benefit.discount_amount != null
        ? `${formatCurrency(benefit.discount_amount)} discount`
        : "Discount";
    return {
      applies,
      text: `${discount} • ${usagePeriodLabel(benefit.usage_period)}`,
    };
  }

  if (benefit.benefit_type === "event_discount_percent") {
    const discount =
      benefit.discount_percent != null
        ? `${benefit.discount_percent}% discount`
        : benefit.discount_amount != null
        ? `${formatCurrency(benefit.discount_amount)} discount`
        : "Discount";
    return {
      applies: false,
      text: `${discount} on events • ${usagePeriodLabel(benefit.usage_period)}`,
    };
  }

  return {
    applies: false,
    text: benefitTypeLabel(benefit.benefit_type),
  };
}

export default function AppointmentCreateForm({
  clients,
  instructors,
  rooms,
  clientPackages,
  clientMemberships,
  initialClientId = "",
  linkedPartnersByClientId = {},
}: {
  clients: ClientOption[];
  instructors: InstructorOption[];
  rooms: RoomOption[];
  clientPackages: ClientPackageOption[];
  clientMemberships: ClientMembershipOption[];
  initialClientId?: string;
  linkedPartnersByClientId?: Record<string, ClientOption[]>;
}) {
  const [state, formAction, pending] = useActionState(createAppointmentAction, initialState);

  const [appointmentType, setAppointmentType] = useState("private_lesson");
  const [clientId, setClientId] = useState(initialClientId);
  const [partnerClientId, setPartnerClientId] = useState("");
  const [linkedPackageId, setLinkedPackageId] = useState("");
  const [floorRentalSlots, setFloorRentalSlots] = useState<FloorRentalSlot[]>([]);
  const [overrideRoomConflict, setOverrideRoomConflict] = useState(false);
  const [priceAmount, setPriceAmount] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("unpaid");
  const [slotDraft, setSlotDraft] = useState<FloorRentalSlot>({
    date: "",
    startTime: "",
    endTime: "",
  });

  const isFloorRental = appointmentType === "floor_space_rental";
  const showPartnerSection =
    appointmentType === "private_lesson" && clientId.length > 0;

  const linkedPartners = useMemo(() => {
    if (!clientId) return [];
    return linkedPartnersByClientId[clientId] ?? [];
  }, [clientId, linkedPartnersByClientId]);


  const selectedPackages = useMemo(() => {
    if (!clientId) return [];
    return clientPackages.filter((pkg) => pkg.client_id === clientId);
  }, [clientId, clientPackages]);

  const selectedPackage = useMemo(() => {
    if (!linkedPackageId) return null;
    return selectedPackages.find((pkg) => pkg.id === linkedPackageId) ?? null;
  }, [linkedPackageId, selectedPackages]);

  const packageHealth = useMemo(
    () => getPackageHealth(selectedPackage),
    [selectedPackage]
  );

  const selectedMembership = useMemo(() => {
    if (!clientId) return null;
    return (
      clientMemberships.find(
        (membership) =>
          membership.client_id === clientId && membership.status === "active"
      ) ?? null
    );
  }, [clientId, clientMemberships]);

  const applicableBenefits = useMemo(() => {
    if (!selectedMembership) return [];
    return selectedMembership.benefits.map((benefit) => ({
      ...benefit,
      summary: membershipBenefitSummary(benefit, appointmentType),
    }));
  }, [selectedMembership, appointmentType]);

  const matchingBenefits = applicableBenefits.filter((b) => b.summary.applies);

  const showPackageSection =
    appointmentType !== "floor_space_rental" && appointmentType !== "event";

  function addFloorRentalSlot() {
    if (!slotDraft.date || !slotDraft.startTime || !slotDraft.endTime) return;

    setFloorRentalSlots((current) => [
      ...current,
      {
        date: slotDraft.date,
        startTime: slotDraft.startTime,
        endTime: slotDraft.endTime,
      },
    ]);

    setSlotDraft({
      date: "",
      startTime: "",
      endTime: "",
    });
  }

  function removeFloorRentalSlot(index: number) {
    setFloorRentalSlots((current) => current.filter((_, i) => i !== index));
  }

  return (
    <form action={formAction} className="space-y-8">
      <input
        type="hidden"
        name="slotsJson"
        value={isFloorRental ? JSON.stringify(floorRentalSlots) : ""}
      />
      <input
        type="hidden"
        name="overrideRoomConflict"
        value={overrideRoomConflict ? "true" : "false"}
      />
      <input
        type="hidden"
        name="partnerClientId"
        value={showPartnerSection ? partnerClientId : ""}
      />

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-6 rounded-2xl border bg-white p-6 shadow-sm">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">New Appointment</h2>
            <p className="mt-2 text-slate-600">
              Create a new appointment, then review package and membership coverage before saving.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="appointmentType" className="mb-1 block text-sm font-medium">
                Appointment Type
              </label>
              <select
                id="appointmentType"
                name="appointmentType"
                value={appointmentType}
                onChange={(e) => setAppointmentType(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="private_lesson">Private Lesson</option>
                <option value="group_class">Group Class</option>
                <option value="intro_lesson">Intro Lesson</option>
                <option value="coaching">Coaching</option>
                <option value="practice_party">Practice Party</option>
                <option value="event">Event</option>
                <option value="floor_space_rental">Floor Space Rental</option>
              </select>
            </div>

            <div>
              <label htmlFor="title" className="mb-1 block text-sm font-medium">
                Title
              </label>
              <input
                id="title"
                name="title"
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
                placeholder={isFloorRental ? "Optional rental title" : "Optional custom title"}
              />
            </div>

            <div>
              <label htmlFor="clientId" className="mb-1 block text-sm font-medium">
                Client
              </label>
              <select
                id="clientId"
                name="clientId"
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                  setPartnerClientId("");
                  setLinkedPackageId("");
                }}
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="">Select client</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.first_name} {client.last_name}
                  </option>
                ))}
              </select>
            </div>

            {showPartnerSection ? (
              <div>
                <label htmlFor="partnerClientId" className="mb-1 block text-sm font-medium">
                  Partner
                </label>
                <select
                  id="partnerClientId"
                  value={partnerClientId}
                  onChange={(e) => setPartnerClientId(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                >
                  <option value="">
                    {linkedPartners.length > 0
                      ? "No partner selected"
                      : "No linked partners available"}
                  </option>
                  {linkedPartners.map((partner) => (
                    <option key={partner.id} value={partner.id}>
                      {partner.first_name} {partner.last_name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-slate-500">
                  Optional. Link a student's saved partner for a couple lesson.
                </p>
              </div>
            ) : null}

            <div>
              <label htmlFor="instructorId" className="mb-1 block text-sm font-medium">
                Instructor
              </label>
              <select
                id="instructorId"
                name="instructorId"
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="">Select instructor</option>
                {instructors.map((instructor) => (
                  <option key={instructor.id} value={instructor.id}>
                    {instructor.first_name} {instructor.last_name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="roomId" className="mb-1 block text-sm font-medium">
                Room
              </label>
              <select
                id="roomId"
                name="roomId"
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="">Select room</option>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="startsAt" className="mb-1 block text-sm font-medium">
                Starts At
              </label>
              <input
                id="startsAt"
                name="startsAt"
                type="datetime-local"
                required={!isFloorRental}
                disabled={isFloorRental}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-100 disabled:text-slate-400"
              />
            </div>

            <div>
              <label htmlFor="endsAt" className="mb-1 block text-sm font-medium">
                Ends At
              </label>
              <input
                id="endsAt"
                name="endsAt"
                type="datetime-local"
                required={!isFloorRental}
                disabled={isFloorRental}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-100 disabled:text-slate-400"
              />
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              New appointments are automatically saved as <span className="font-medium text-slate-900">Scheduled</span>.
            </div>
          </div>

          {isFloorRental ? (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Floor Rental Slots</h3>
                <p className="mt-1 text-sm text-slate-600">
                  Add one or more rental blocks. Each slot will be created as its own floor rental appointment.
                </p>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-4">
                <div>
                  <label className="mb-1 block text-sm font-medium">Slot Date</label>
                  <input
                    type="date"
                    value={slotDraft.date}
                    onChange={(e) =>
                      setSlotDraft((current) => ({ ...current, date: e.target.value }))
                    }
                    className="w-full rounded-xl border border-slate-300 px-3 py-2"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium">Start Time</label>
                  <input
                    type="time"
                    value={slotDraft.startTime}
                    onChange={(e) =>
                      setSlotDraft((current) => ({ ...current, startTime: e.target.value }))
                    }
                    className="w-full rounded-xl border border-slate-300 px-3 py-2"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium">End Time</label>
                  <input
                    type="time"
                    value={slotDraft.endTime}
                    onChange={(e) =>
                      setSlotDraft((current) => ({ ...current, endTime: e.target.value }))
                    }
                    className="w-full rounded-xl border border-slate-300 px-3 py-2"
                  />
                </div>

                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={addFloorRentalSlot}
                    className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-900 hover:bg-slate-100"
                  >
                    Add Slot
                  </button>
                </div>
              </div>

              {floorRentalSlots.length === 0 ? (
                <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-slate-500">
                  No floor rental slots added yet.
                </div>
              ) : (
                <div className="mt-4 space-y-3">
                  {floorRentalSlots.map((slot, index) => (
                    <div
                      key={`${slot.date}-${slot.startTime}-${slot.endTime}-${index}`}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3"
                    >
                      <div>
                        <p className="font-medium text-slate-900">
                          {formatShortDate(slot.date)}
                        </p>
                        <p className="text-sm text-slate-600">
                          {slot.startTime} – {slot.endTime}
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() => removeFloorRentalSlot(index)}
                        className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-100"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {showPackageSection ? (
            <div>
              <label htmlFor="clientPackageId" className="mb-1 block text-sm font-medium">
                Linked Package
              </label>
              <select
                id="clientPackageId"
                name="clientPackageId"
                value={linkedPackageId}
                onChange={(e) => setLinkedPackageId(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
                disabled={!clientId}
              >
                <option value="">
                  {clientId ? "No linked package" : "Select a client first"}
                </option>
                {selectedPackages.map((pkg) => (
                  <option key={pkg.id} value={pkg.id}>
                    {pkg.name_snapshot}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <input type="hidden" name="clientPackageId" value="" />
          )}

          {isFloorRental ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold text-emerald-900">
                    Floor Rental Pricing
                  </h3>
                  <p className="mt-1 text-sm text-emerald-800">
                    Set the rental amount now so staff can charge it and the appointment can track payment status.
                  </p>
                </div>
                <span className="inline-flex rounded-full bg-white px-3 py-1 text-xs font-medium text-emerald-700">
                  {paymentStatusLabel(paymentStatus)}
                </span>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div>
                  <label htmlFor="priceAmount" className="mb-1 block text-sm font-medium">
                    Rental Amount
                  </label>
                  <input
                    id="priceAmount"
                    name="priceAmount"
                    type="number"
                    min="0"
                    step="0.01"
                    value={priceAmount}
                    onChange={(e) => setPriceAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full rounded-xl border border-emerald-300 bg-white px-3 py-2"
                  />
                  <p className="mt-1 text-xs text-emerald-700">
                    Leave blank only if you want to price it later.
                  </p>
                </div>

                <div>
                  <label htmlFor="paymentStatus" className="mb-1 block text-sm font-medium">
                    Initial Payment Status
                  </label>
                  <select
                    id="paymentStatus"
                    name="paymentStatus"
                    value={paymentStatus}
                    onChange={(e) => setPaymentStatus(e.target.value)}
                    className="w-full rounded-xl border border-emerald-300 bg-white px-3 py-2"
                  >
                    <option value="unpaid">Unpaid</option>
                    <option value="partial">Partially Paid</option>
                    <option value="paid">Paid</option>
                    <option value="waived">Waived</option>
                  </select>
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-emerald-200 bg-white p-4 text-sm text-emerald-900">
                <p className="font-medium">Recommended workflow</p>
                <p className="mt-1 text-emerald-800">
                  Create the rental as unpaid, then collect payment from the detail page with Charge, Purchase, or Record Manual Payment.
                </p>
              </div>
            </div>
          ) : (
            <>
              <input type="hidden" name="priceAmount" value="" />
              <input type="hidden" name="status" value="scheduled" />
              <input type="hidden" name="paymentStatus" value="unpaid" />
            </>
          )}

          <div>
            <label htmlFor="notes" className="mb-1 block text-sm font-medium">
              Notes
            </label>
            <textarea
              id="notes"
              name="notes"
              rows={4}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>

          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <label className="flex items-start gap-3 text-sm text-amber-900">
              <input
                type="checkbox"
                checked={overrideRoomConflict}
                onChange={(e) => setOverrideRoomConflict(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-amber-300"
              />
              <span>
                Override room conflict warning and continue.
                <span className="mt-1 block text-xs text-amber-700">
                  Use this only when you intentionally want to double-book the room.
                </span>
              </span>
            </label>
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
                ? "Saving..."
                : isFloorRental
                ? "Create Floor Rentals"
                : "Create Appointment"}
            </button>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h3 className="text-xl font-semibold">Package Health</h3>
            <p className="mt-2 text-sm text-slate-600">
              Review the linked package before scheduling against it.
            </p>

            {!showPackageSection ? (
              <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-slate-500">
                Package linking is not used for {appointmentTypeLabel(appointmentType).toLowerCase()}.
              </div>
            ) : !clientId ? (
              <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-slate-500">
                Select a client to review package options.
              </div>
            ) : !selectedPackage ? (
              <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-slate-500">
                No linked package selected.
              </div>
            ) : (
              <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-5">
                <div className="flex flex-wrap items-center gap-3">
                  <p className="font-semibold text-slate-900">
                    {selectedPackage.name_snapshot}
                  </p>
                  <span
                    className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${packageHealthClass(
                      packageHealth
                    )}`}
                  >
                    {packageHealthLabel(packageHealth)}
                  </span>
                </div>

                <p className="mt-3 text-sm text-slate-600">
                  {summarizeClientPackageItems(selectedPackage.client_package_items)}
                </p>

                {"expiration_date" in selectedPackage ? (
                  <p className="mt-2 text-sm text-slate-500">
                    Expires: {formatShortDate(selectedPackage.expiration_date ?? null)}
                  </p>
                ) : null}

                {packageWarningMessage(packageHealth) ? (
                  <div
                    className={`mt-4 rounded-xl border px-3 py-2 text-sm ${
                      packageHealth === "depleted" ||
                      packageHealth === "inactive" ||
                      packageHealth === "expired"
                        ? "border-red-200 bg-red-50 text-red-800"
                        : "border-amber-200 bg-amber-50 text-amber-800"
                    }`}
                  >
                    {packageWarningMessage(packageHealth)}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h3 className="text-xl font-semibold">Membership Benefits</h3>
            <p className="mt-2 text-sm text-slate-600">
              Check whether the client’s active membership includes or discounts this appointment type.
            </p>

            {!clientId ? (
              <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-slate-500">
                Select a client to review membership coverage.
              </div>
            ) : !selectedMembership ? (
              <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-slate-500">
                No active membership found for this client.
              </div>
            ) : (
              <div className="mt-5 space-y-4">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="font-semibold text-slate-900">
                      {selectedMembership.name_snapshot}
                    </p>
                    <span className="inline-flex rounded-full bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700">
                      {selectedMembership.status}
                    </span>
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <div className="rounded-xl border bg-white p-4">
                      <p className="text-sm text-slate-500">Billing</p>
                      <p className="mt-1 font-medium text-slate-900">
                        {formatCurrency(selectedMembership.price_snapshot)} /{" "}
                        {billingIntervalLabel(selectedMembership.billing_interval_snapshot)}
                      </p>
                    </div>

                    <div className="rounded-xl border bg-white p-4">
                      <p className="text-sm text-slate-500">Current Period</p>
                      <p className="mt-1 font-medium text-slate-900">
                        {formatShortDate(selectedMembership.current_period_start)} –{" "}
                        {formatShortDate(selectedMembership.current_period_end)}
                      </p>
                    </div>
                  </div>
                </div>

                {matchingBenefits.length > 0 ? (
                  <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
                    This membership includes or discounts the selected appointment type.
                  </div>
                ) : (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    No direct membership benefit applies to {appointmentTypeLabel(appointmentType).toLowerCase()}.
                  </div>
                )}

                <div className="space-y-3">
                  {applicableBenefits.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-slate-500">
                      No benefits configured on this membership.
                    </div>
                  ) : (
                    applicableBenefits.map((benefit, index) => (
                      <div
                        key={`${benefit.benefit_type}-${index}`}
                        className={`rounded-xl border p-4 ${
                          benefit.summary.applies
                            ? "border-green-200 bg-green-50"
                            : "border-slate-200 bg-slate-50"
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-slate-900">
                            {benefitTypeLabel(benefit.benefit_type)}
                          </p>

                          {benefit.summary.applies ? (
                            <span className="inline-flex rounded-full bg-green-100 px-2 py-1 text-xs font-medium text-green-700">
                              Applies
                            </span>
                          ) : (
                            <span className="inline-flex rounded-full bg-slate-200 px-2 py-1 text-xs font-medium text-slate-700">
                              Not used here
                            </span>
                          )}
                        </div>

                        <p className="mt-2 text-sm text-slate-600">
                          {benefit.summary.text}
                        </p>

                        {benefit.applies_to ? (
                          <p className="mt-1 text-xs text-slate-500">
                            Applies to: {benefit.applies_to}
                          </p>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}