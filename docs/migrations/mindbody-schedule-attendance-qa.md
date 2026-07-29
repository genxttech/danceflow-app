# Mindbody Schedule, Classes, and Attendance QA

## Schedule order
- Import clients and instructors first.
- Import packages and memberships before future bookings when entitlement references exist.
- Run appointments before attendance.

## Appointments, classes, and enrollments
- Retain Booking ID as the durable appointment source identity.
- Resolve Client ID and Staff ID before email fallback.
- Preserve service name, location, room, start time, end time, and booking status.
- Review instructor, client, and room overlaps.
- Compare private appointment, class, enrollment, and workshop counts with the source.
- Confirm future bookings retain the correct package or contract reference when supported.

## Attendance
- Retain Visit ID and Booking ID.
- Preserve attended, no-show, late-cancel, and cancelled outcomes.
- Map late-cancel to cancelled appointment state while retaining it in reconciliation counts.
- Surface waitlisted rows as class-roster exceptions instead of converting them to attendance.
- Confirm historical attendance does not consume package visits or membership entitlements again.

## Reruns
- Create Only must skip existing Booking IDs.
- Create or Update must update the same source-linked appointment.
- Attendance reruns must update status only and remain non-deducting.

## Reconciliation
- Compare future and historical schedule totals by date range.
- Compare attendance outcomes by status.
- Resolve missing clients, missing instructors, overlaps, and waitlist exceptions.
- Resolve all required schedule exceptions before financial reconciliation and activation.
