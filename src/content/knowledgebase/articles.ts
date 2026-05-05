export type KnowledgebaseAudience = "public" | "app" | "both";

export type KnowledgebaseArticle = {
  slug: string;
  title: string;
  category: string;
  description: string;
  audience: KnowledgebaseAudience;
  content: string;
};

export const knowledgebaseArticles: KnowledgebaseArticle[] = [
  {
    slug: "what-is-danceflow",
    title: "What is DanceFlow?",
    category: "Getting Started",
    audience: "public",
    description:
      "Learn how DanceFlow helps studios manage operations while helping dancers discover places to dance.",
    content: `
## Overview

DanceFlow is a dance studio CRM, scheduler, and discovery platform built to help studios manage their business while helping dancers find places to dance.

Most studio tools focus only on internal scheduling or payments. DanceFlow connects both sides of the business:

**Studio operations + public discovery**

That means studios can manage clients, lessons, instructors, packages, memberships, payments, rooms, and leads while also giving dancers a way to discover studios, events, classes, and opportunities.

## Who DanceFlow is for

DanceFlow is designed for:

- Ballroom dance studios
- Country dance studios
- Independent dance instructors
- Event organizers
- Studio owners who rent floor space
- Front desk and admin staff who manage daily studio operations

## What studios can manage

Studios can use DanceFlow to manage:

- Clients and leads
- Private lessons
- Instructor schedules
- Rooms and floor spaces
- Package templates
- Client package balances
- Membership plans
- Payments
- Client portal access
- Independent instructor floor rentals
- Reports

## What makes DanceFlow different

DanceFlow is built around real studio workflows.

Instead of only acting as a calendar or payment system, DanceFlow helps connect the full path:

**Dancer discovers studio → becomes a lead → becomes a client → books lessons → buys packages or memberships → stays connected through the portal**

For studios that rent floor space, DanceFlow also supports independent instructor portal access so instructors can book host studio floor space while keeping their own business separate.
`,
  },
  {
    slug: "getting-started-checklist-for-studios",
    title: "Getting Started Checklist for Studios",
    category: "Getting Started",
    audience: "public",
    description:
      "A practical checklist for setting up a new studio workspace in DanceFlow.",
    content: `
## Overview

This checklist helps a new studio get ready to use DanceFlow for daily operations.

You do not need to complete everything at once. Start with the basics, then add packages, memberships, and portal access as your studio grows into the system.

## Step 1: Start your studio trial

Choose a studio plan and begin your free trial.

After your trial starts, your studio workspace will become available inside the app.

## Step 2: Complete your public profile

Your public profile controls how your studio appears in DanceFlow discovery.

Add:

- Studio name
- Public description
- Location
- Contact information
- Website or social links
- Photos, if available

A strong public profile helps dancers understand who you are and how to connect with you.

## Step 3: Import your existing client list, if applicable

If you already have clients in another system or spreadsheet, use the import tool to upload them into DanceFlow.

Go to **Settings > Import**.

Upload your client CSV, review the file for errors, fix any flagged rows, then execute the import. After the import runs, confirm the clients appear on the Clients page.

Skip this step if you are starting fresh or prefer to add clients manually.

## Step 4: Add instructors

Add instructors who can be scheduled for lessons or classes.

Studio owners can also be instructors. If the owner teaches, they should have an instructor profile so they can be booked on the schedule.

## Step 5: Add rooms or floor spaces

Rooms help your studio organize scheduling and availability.

You can create rooms for:

- Private lesson rooms
- Ballrooms
- Practice floors
- Rental spaces
- General floor areas

Rooms can also be blocked when they are unavailable.

## Step 6: Add clients

Add current clients to your CRM.

At minimum, enter:

- First name
- Last name
- Email
- Phone number, if available

Clients can later be linked to portal access so they can view relevant information.

## Step 7: Create package templates

Package templates make it faster to sell lessons, group classes, or party credits.

Examples:

- 5 private lessons
- 10 private lessons
- New student intro package
- Group class bundle
- Practice party bundle
- Mixed package with lessons, groups, and parties

## Step 8: Create membership plans

Memberships are useful for recurring revenue.

Examples:

- Monthly group class membership
- Practice membership
- Lesson discount membership
- Floor rental discount membership

## Step 9: Connect billing and payouts

If your studio will collect online payments, connect Stripe payouts before taking paid registrations or online payments.

This allows your studio to receive funds properly.

## Step 10: Start scheduling

Once instructors, clients, and rooms are set up, begin creating appointments.

You can schedule:

- Private lessons
- Floor rentals
- Room blocks
- Other studio appointments

## Step 11: Review reports and payments

Use reports and client payment history to monitor activity, revenue, packages, and balances.
`,
  },
  {
    slug: "importing-client-data-from-a-csv",
    title: "Importing Client Data from a CSV",
    category: "Getting Started",
    audience: "public",
    description:
      "Learn how to upload, review, and execute a client CSV import in DanceFlow.",
    content: `
## Overview

Use the import tool when you are moving client records into DanceFlow from another system or spreadsheet.

Importing helps you add many clients at once instead of creating each client manually.

## Before you start

Make sure your CSV file is clean and easy to read. Each client should be on its own row.

Recommended columns:

- first_name
- last_name
- email
- phone
- status
- is_independent_instructor

The most important fields are first name, last name, and email. If a client does not have an email address, they may not be able to use portal access until one is added.

## Step 1: Open the import page

From your studio dashboard, go to:

**Settings > Import**

## Step 2: Upload your CSV file

Choose the client import option.

Select your CSV file.

Choose the import mode.

Use **Dry Run** if you want to test the file first without adding clients.

Use **Create or Update** when you are ready to add or update client records.

Click **Upload**.

## Step 3: Review the uploaded file

After the file uploads, find it in Recent Imports.

Click **Review Clients File**.

DanceFlow will check the file for common problems before importing.

## Step 4: Fix any errors

If DanceFlow finds problems, review the error message and update your CSV.

Common issues include:

- Missing required fields
- Duplicate emails
- Invalid status values
- Incorrect column names
- Blank rows
- File saved in the wrong format

After fixing the CSV, upload it again and review it.

## Step 5: Execute the import

Once the file review passes, open the review page.

Click **Execute Import** or **Import Ready Rows**.

DanceFlow will add the valid client records to your studio.

## Step 6: Confirm the import

Go to **Clients** and confirm the new clients appear.

Check a few imported client records to make sure names, email addresses, phone numbers, and status values imported correctly.

## Common troubleshooting

### The file uploads, but no clients appear

Uploading only creates an import batch. You still need to review and execute the import.

Go to Recent Imports, click **Review Clients File**, then open the review page and execute the import.

### The review says the CSV could not be reviewed

The system could not validate the file. This may happen if the file is missing expected columns, cannot be read, or has permission issues.

Make sure the file is a CSV, check that the column headers are correct, remove blank header columns, save the file again as CSV, and upload it again.

### Some rows imported, but others did not

DanceFlow imported valid rows and skipped or failed rows with problems.

Open the import review and check row-level errors. Correct the failed rows in the CSV, then upload a corrected file.

### Duplicate clients appear

The file may contain repeated emails, or the existing client did not match the imported row.

Use email addresses as the main identifier, remove duplicate rows from the CSV, and use Create or Update mode when updating existing client records.

### Independent instructor clients imported as regular clients

Depending on the current import mapping, independent instructor access may need to be confirmed after import.

After import, open the client record and confirm whether Independent Instructor access should be enabled. If needed, update the client manually and link portal access.

## Best practices

- Run a dry run first.
- Start with a small test file before importing a large list.
- Keep a backup of your original CSV.
- Review imported clients before inviting them to the portal.
- Do not import old or unverified email addresses without checking them first.
`,
  },
  {
    slug: "packages-vs-memberships",
    title: "Packages vs Memberships",
    category: "Sales & Revenue",
    audience: "public",
    description:
      "Understand when to use packages, when to use memberships, and how both can work together.",
    content: `
## Overview

Packages and memberships both help studios sell services, but they solve different problems.

Use packages when a client buys a set number of credits.

Use memberships when a client pays on a recurring schedule for ongoing access or benefits.

## Packages

A package is a prepaid set of credits.

Packages can include:

- Private lesson credits
- Group class credits
- Practice party credits
- Mixed credits

Example:

**Beginner Dance Package**

- 5 private lessons
- 2 group classes
- 1 practice party

Packages are best for:

- Lesson bundles
- Intro offers
- Prepaid private lessons
- Mixed dance programs
- Tracking remaining credits

When a package is sold, DanceFlow tracks the client’s remaining credits.

If a correction is needed, staff can use **Package Count Correction** to add or debit credits with an audit note.

## Memberships

A membership is a recurring plan.

Memberships can be used for:

- Monthly access
- Recurring class benefits
- Practice access
- Discounts
- Ongoing studio programs

Example:

**Social Dancer Membership**

$99/month

Includes weekly group classes and practice benefits.

Memberships are best for:

- Recurring revenue
- Ongoing student engagement
- Monthly programs
- Discount structures
- Retention-based offers

## When to use a package

Use a package when the client is buying a specific number of credits.

Examples:

- 10 private lessons
- 5 group classes
- New student intro bundle
- Wedding lesson package

## When to use a membership

Use a membership when the client is paying on a recurring basis.

Examples:

- Monthly group class plan
- Practice floor membership
- VIP lesson discount plan
- Unlimited social dance membership

## Can a client have both?

Yes.

A client may have:

**A private lesson package + a monthly group class membership**

This is common for active dancers who take private lessons while also joining recurring studio programs.
`,
  },
  {
    slug: "independent-instructors-and-host-studio-rentals",
    title: "Independent Instructors and Host Studio Rentals",
    category: "Independent Instructors",
    audience: "public",
    description:
      "Learn how DanceFlow supports independent instructors who rent space from host studios.",
    content: `
## Overview

DanceFlow supports independent instructors who rent floor space from host studios.

This is designed for real-world studio relationships where an instructor may teach their own clients while renting space from another studio.

## Two types of independent instructors

DanceFlow supports two common independent instructor scenarios.

## Portal-only independent instructor

This instructor does not have their own DanceFlow subscription.

A host studio adds them as an independent instructor client and gives them portal access.

They can use the host studio portal to:

- Book floor space
- View rentals
- Track rental payment status
- Pay or manage rental balances when enabled

They do not get access to the host studio’s internal workspace.

## Subscribed independent instructor

This instructor has their own DanceFlow workspace and subscription.

They can manage their own:

- Clients
- Lessons
- Packages
- Payments
- Schedule

They can also stay linked to host studios where they rent space.

Inside their own workspace, they will see a **Host Studio Portal** card that links back to the host studio portal for rentals.

## Important access rule

A host studio portal link is not the same as workspace access.

**Host studio portal access = floor rental relationship**

**Studio workspace access = internal staff/admin access**

Independent instructors should not receive host studio workspace access unless the studio intentionally adds them as staff.

## Booking a lesson with host studio floor space

A subscribed independent instructor should create a normal private lesson in their own workspace.

During lesson creation, they can also book floor space with a linked host studio.

Typical flow:

**Create Private Lesson → Select client → Select instructor → Choose date and time → Select linked host studio → Select room/floor/area if needed → Save**

This creates the lesson in the instructor’s own workspace and creates the related floor rental with the host studio.

## Room availability

Host studios can block rooms or spaces when unavailable.

If a room or full studio block conflicts with a rental request, DanceFlow should prevent the booking.
`,
  },
  {
    slug: "billing-payments-and-payouts",
    title: "Billing, Payments, and Payouts",
    category: "Billing & Payments",
    audience: "public",
    description:
      "Understand the difference between DanceFlow subscription billing, client payments, and Stripe payouts.",
    content: `
## Overview

DanceFlow uses billing, payments, and payouts for different parts of the business.

Understanding the difference helps studio owners know what each area controls.

## Subscription billing

Subscription billing is for your DanceFlow plan.

This controls access to the software.

Examples:

- Starting a trial
- Managing your DanceFlow subscription
- Updating billing information
- Canceling or changing a plan

Subscription billing is managed from the Billing & Payouts area.

## Client payments

Client payments are payments your studio records or collects from clients.

Examples:

- Package sales
- Membership payments
- Floor rental payments
- Event registrations
- General balance payments

The Client Payments page helps staff search and review payment activity.

You can filter by:

- Client
- Date range
- Payment status
- Payment method
- Source
- Payment type

## Payouts

Payouts are how your studio receives money from online payments.

If your studio plans to collect online payments, Stripe payout setup should be completed before taking paid registrations or online transactions.

Payout setup is important because it allows funds to move properly to your studio.

## Manual payments vs online payments

DanceFlow can track manual payments such as:

- Cash
- Check
- Zelle
- Venmo
- Other offline payments

It can also track online payment activity when connected.

Manual payments are useful when staff need to record a payment that happened outside the system.

## Best practice

Before launch, studios should confirm:

- DanceFlow subscription is active
- Stripe payout setup is complete if collecting online payments
- Package and membership prices are correct
- Staff know where to review client payments

This keeps billing and client payment workflows clear for owners and front desk staff.
`,
  },
  {
    slug: "client-portal-linking-invites-vs-existing-accounts",
    title: "Client Portal Linking: Invites vs Existing Accounts",
    category: "Clients & Portals",
    audience: "both",
    description:
      "Learn how to connect a client record to portal access, when to send an invite, and when to link an existing account.",
    content: `
## Overview

Client portal access connects a client record in your studio to the client’s DanceFlow login account.

The goal is:

**Client record in your studio + client login account = client portal access**

Once linked, the client can log in through **Public Account / Client Portal** and access the portal for your studio.

## Invite vs link

There are two common ways to give a client portal access.

| Action | Best For | What Happens |
|---|---|---|
| Send Portal Invite | New clients or clients who have not logged in before | DanceFlow emails the client a secure sign-in link so they can activate access |
| Link Existing Account | Clients who already have a DanceFlow account | Their existing account is connected to the client record in your studio |

## When to send a portal invite

Send an invite when the client is new to DanceFlow or you are not sure whether they have created an account yet.

Use this when:

- The client has never logged in before
- The client does not already have a DanceFlow public account
- You want DanceFlow to email them a secure access link
- You want the client to activate their own portal access

Before sending the invite, confirm the client record has the correct email address.

## When to link an existing account

Use linking when the client already has a DanceFlow public account or portal account using the same email address.

Use this when:

- The client says they already created a DanceFlow account
- The client used public discovery before
- The client registered for an event using the same email
- The client already has portal access with another studio

The client does not need a second DanceFlow account. Their existing login can be connected to your studio’s client record.

## Why the email address matters

DanceFlow uses the email address to match the client record to the login account.

Check for:

- Misspelled email addresses
- Old email addresses
- Duplicate client records
- A different email used by the client for DanceFlow

If the email does not match, the client may log in but not see the correct portal.

## How to send a client portal invite

1. Go to **Clients**.
2. Open the client record.
3. Confirm the client has a valid email address.
4. Choose the portal invite option.
5. Send the invite.

The client will receive an email from DanceFlow with a secure sign-in link.

When the client clicks the link, DanceFlow should activate the session and send them directly to the correct portal.

## How to link an existing account

1. Go to **Clients**.
2. Open the client record.
3. Confirm the email matches the account the client already uses.
4. Use the portal linking option.
5. Save the change.

After linking, the client can log in through **Public Account / Client Portal** and access your studio portal.

## What the client should do

The client should:

1. Open the email from DanceFlow.
2. Click the secure sign-in link.
3. Land in their client portal.
4. Use the same email address for future portal access.

They should not need to request multiple magic links to activate portal access.

## Troubleshooting

### The client did not receive the invite

Ask them to check:

- Spam or junk folder
- Promotions tab
- Whether the studio has the correct email address
- Whether their inbox blocks automated emails

### The client logged in but does not see the portal

Check:

- The email on the client record matches the login email
- The client record is linked to their portal account
- The client is not duplicated in the CRM
- The client is using **Public Account / Client Portal**, not **Studio Login**

### The client used the wrong email

Update the client record with the correct email address, then resend the invite or link the correct existing account.

## Best practices

- Confirm the client email before sending an invite.
- Avoid duplicate client records.
- Use one DanceFlow account per client whenever possible.
- For clients connected to multiple studios, use the same email so their portal access can stay connected.
`,
  },
  {
    slug: "making-your-studio-visible-in-public-discovery",
    title: "Making Your Studio Visible in Public Discovery",
    category: "Public Discovery & Leads",
    audience: "both",
    description:
      "Learn what controls whether your studio appears in public discovery and how to improve your public listing.",
    content: `
## Overview

Public discovery helps dancers find studios on DanceFlow.

Your studio only appears publicly when public directory visibility is enabled and the required public profile details are saved.

## What controls public visibility

Your studio must have public discovery enabled.

The most important setting is:

**Public Directory Enabled**

When this is turned on, your studio can appear in public discovery.

## Recommended public profile fields

For the best listing, complete:

- Public studio name
- Short public description
- About this studio
- City
- State
- ZIP code
- Public phone or email, if you want it shown
- Website URL
- Studio logo
- Hero image

## Location and search

DanceFlow uses your location details to help with discovery and Search Near Me.

Add at least:

- City
- State
- ZIP code

When geocoding is enabled, DanceFlow can store latitude and longitude to make nearby search more accurate.

## Why your studio may not appear

Common reasons include:

- Public directory is turned off
- The studio has no public location details
- Search filters are hiding the studio
- The public profile was saved before required fields were completed
- The page needs to be refreshed after saving settings

## Best practices

- Use a clear short description.
- Add a welcoming About section.
- Upload a clean logo and hero image.
- Use the city and ZIP where dancers are most likely to search.
- Keep public contact details current.
`,
  },
  {
    slug: "setting-up-your-public-studio-profile",
    title: "Setting Up Your Public Studio Profile",
    category: "Public Discovery & Leads",
    audience: "both",
    description:
      "Learn how to complete the public-facing studio profile that dancers see in DanceFlow.",
    content: `
## Overview

Your public studio profile is the page dancers see when they view your studio on DanceFlow.

A complete profile helps dancers understand who you are, what you offer, and how to take the next step.

## Profile fields to complete

In studio settings, complete:

- Public studio name
- Short description
- About this studio
- Phone
- Email
- Website
- Logo
- Hero image
- Public lead headline
- Public lead description

## Short description vs About this studio

The short description is used for quick previews, such as discovery cards.

The About section is longer and appears on your public studio profile.

Use the short description to quickly explain what your studio offers.

Use the About section to welcome dancers and explain your style, programs, and personality.

## Logo and hero image

Upload a logo and hero image to make the public profile feel polished.

Use supported image formats such as PNG, JPG, JPEG, or WebP.

Keep image sizes reasonable so the page loads quickly.

## Lead form copy

The public lead form has its own headline and description.

Use this section to tell dancers what to do next.

Examples:

- Request an intro lesson
- Ask about private lessons
- Contact us about beginner classes
- Get help finding the right program

## Best practices

- Keep language friendly and clear.
- Write for beginners, not just experienced dancers.
- Explain what happens after someone submits the form.
- Make the next step easy to understand.
`,
  },
  {
    slug: "setting-up-intro-lesson-requests",
    title: "Setting Up Intro Lesson Requests",
    category: "Public Discovery & Leads",
    audience: "both",
    description:
      "Learn how intro lesson requests work and how studios can use them to turn public interest into leads.",
    content: `
## Overview

Intro lesson requests let dancers express interest in starting with your studio from your public profile.

In the current version, an intro lesson request is captured as a lead so your studio can follow up manually.

## What happens when intro lesson requests are enabled

When enabled, the public form uses intro lesson language.

The visitor can submit their contact information and request help getting started.

DanceFlow saves the request as a lead with intro lesson intent so your team knows how to follow up.

## When to use this setting

Use intro lesson requests if your studio offers:

- New student intro lessons
- First private lesson consultations
- Beginner trial lessons
- Wedding dance consultations
- Starter sessions for new dancers

## Suggested follow-up process

After receiving an intro lesson request:

1. Review the lead details.
2. Contact the dancer quickly.
3. Ask about goals, availability, and experience level.
4. Assign an instructor if needed.
5. Create an appointment once the time is confirmed.

## Recommended copy

Use friendly beginner-focused language.

Examples:

- Request an intro lesson
- Tell us what you want to learn
- We will help match you with the right next step
- No partner or experience required

## Phase 2 note

Future versions may support fuller intro lesson booking, including availability windows, instructor assignment, room assignment, and appointment confirmation.
`,
  },
  {
    slug: "troubleshooting-client-portal-invite-emails",
    title: "Troubleshooting Client Portal Invite Emails",
    category: "Clients & Portals",
    audience: "both",
    description:
      "Steps to take when a client says they did not receive or cannot use a portal invite email.",
    content: `
## Overview

Client portal invites are sent by email. If a client says they did not receive the invite or cannot access the portal, start with the checks below.

## Step 1: Confirm the email address

Open the client record and confirm the email address is correct.

Check for:

- Typos
- Old email addresses
- Extra spaces
- Duplicate client records with different emails

## Step 2: Ask the client to check folders

Ask the client to check:

- Inbox
- Spam
- Junk
- Promotions
- Updates

If the email is found in spam, ask the client to mark it as not spam.

## Step 3: Confirm which login they are using

Clients should use:

**Public Account / Client Portal**

They should not use **Studio Login** unless they are staff or an instructor with workspace access.

## Step 4: Confirm the portal is linked

If the client can log in but cannot see the portal, the client record may not be linked to their account.

Check that:

- The client record email matches their login email
- The portal user/account is linked to the client record
- The client is not duplicated under another email

## Step 5: Resend the invite if needed

If the email address is correct but the client did not receive the invite, resend it.

If the client already has a DanceFlow account, use the existing account linking process instead of creating a duplicate account.

## Best practices

- Use notify@idanceflow.com or another verified sender.
- Avoid sending many repeated invites in a short time.
- Tell clients to search for DanceFlow in their inbox.
- Use one email per client whenever possible.
`,
  },
  {
    slug: "getting-started-with-organizer-workspace",
    title: "Getting Started with Your Organizer Workspace",
    category: "Getting Started",
    audience: "public",
    description:
      "Learn the core steps for setting up an organizer workspace, creating events, and preparing to take registrations.",
    content: `
## Overview

Organizer workspaces are built for event organizers who need to create events, sell tickets, manage registrations, and run check-in.

Use this guide when you are setting up an organizer workspace for the first time.

## Step 1: Review your organizer workspace

After signing in, open your organizer dashboard.

Confirm that you are in the correct workspace and that the workspace name matches the organizer or event business you are managing.

## Step 2: Complete organizer settings

Go to your settings area and confirm your organizer information.

Review:

- Organizer name
- Public display name
- Contact information
- Branding or logo, if available
- Public-facing details

This information helps attendees understand who is hosting the event.

## Step 3: Connect payouts

Before taking paid registrations, connect payouts.

This allows event revenue to be processed correctly and helps avoid problems with paid registrations.

If payouts are not connected, DanceFlow may show a dashboard reminder so you know what still needs to be completed.

## Step 4: Create your first event

Create your first event from the Events area.

Events can include:

- Group classes
- Workshops
- Social dances
- Competitions
- Showcases
- Festivals
- Special events

Choose the event type that best matches what you are running.

## Step 5: Add tickets or registration options

After creating the event, add ticket types or registration options.

Examples:

- General admission
- Early bird ticket
- Student ticket
- Couple registration
- Spectator ticket
- Performer or competitor registration

The available options may depend on the type of event you are creating.

## Step 6: Publish the event

When the event details are ready, publish the event.

If you want dancers to find it through public discovery, make sure public visibility and directory settings are enabled.

## Step 7: Test the registration flow

Before promoting the event widely, test the registration process.

Confirm that:

- The event page loads correctly
- Ticket options are visible
- Registration details are clear
- Payment or admin registration works as expected
- The attendee appears in Manage Registrations

## Step 8: Manage registrations and check-in

As registrations come in, use the event management tools to review attendees, payment status, and check-in status.

On event day, use the Check-In page to mark attendees as arrived.
`,
  },
  {
    slug: "using-the-workspace-setup-checklist",
    title: "Using the Workspace Setup Checklist",
    category: "Getting Started",
    audience: "public",
    description:
      "Learn how the dashboard setup checklist helps studios and organizers complete their first workspace setup steps.",
    content: `
## Overview

The workspace setup checklist appears on the dashboard when a studio or organizer workspace still has important setup steps remaining.

The checklist is designed to help new users know what to do next without guessing.

## What the checklist does

The checklist shows the main setup tasks needed to make the workspace useful.

For studio workspaces, it may include tasks like:

- Review studio settings
- Add instructors
- Add or import clients
- Create or sell packages
- Add a schedule item
- Connect billing and payouts
- Invite students to the portal

For organizer workspaces, it may include tasks like:

- Create organizer profile
- Connect payouts
- Create first event
- Publish event
- Turn on public discovery
- Confirm registration flow

## How tasks are marked complete

Checklist items update automatically when DanceFlow detects that the related task has been completed.

Examples:

- If you add a client, the client task can be marked complete.
- If you add an instructor, the instructor task can be marked complete.
- If you create an event, the event task can be marked complete.
- If payouts are connected, the payouts task can be marked complete.

This helps the checklist reflect real workspace progress.

## What happens when the checklist is complete

Once all setup tasks are complete, the checklist disappears from the dashboard.

The checklist is meant to guide setup, not permanently take up dashboard space.

## Hiding the checklist

If you do not want to see the checklist right now, use **Hide for now**.

This hides the checklist for your user account and workspace.

## Best practice

Use the checklist as a quick launch guide.

You do not have to complete everything at once. Start with the tasks that matter most for your current workflow, then return to the rest later.
`,
  },
  {
    slug: "syncing-instructor-schedule-to-calendar",
    title: "Syncing an Instructor Schedule to Google, Apple, or Outlook Calendar",
    category: "Scheduling",
    audience: "public",
    description:
      "Learn how instructors can subscribe to their DanceFlow schedule from a mobile or desktop calendar app.",
    content: `
## Overview

Instructor calendar sync lets instructors view their DanceFlow schedule inside calendar apps such as Google Calendar, Apple Calendar, Outlook, or a mobile phone calendar.

This is a read-only calendar feed. It helps instructors see their schedule outside DanceFlow without changing appointments from the calendar app.

## What calendar sync is useful for

Calendar sync helps instructors:

- View upcoming lessons
- See group classes or coaching sessions
- Keep DanceFlow appointments visible on a phone
- Avoid checking multiple systems throughout the day

## How it works

DanceFlow creates a private calendar subscription link for the instructor.

The instructor copies that link and adds it to a calendar app as a subscribed calendar.

Once added, appointments from DanceFlow appear in the calendar app.

## Important notes

The calendar feed is read-only.

That means:

- Appointments should still be created in DanceFlow
- Schedule changes should still be made in DanceFlow
- Deleting an item from the external calendar does not delete it from DanceFlow
- Calendar apps may not refresh immediately after a schedule change

## Refresh timing

Google Calendar, Apple Calendar, Outlook, and mobile calendar apps control how often subscribed calendars refresh.

A new or changed appointment may not appear instantly.

If the calendar looks outdated, wait for the calendar app to refresh or remove and re-add the subscription if needed.

## Privacy reminder

The calendar subscription link should be treated like a private link.

Do not post it publicly or share it with someone who should not see the instructor schedule.
`,
  },
  {
    slug: "creating-multi-location-multi-date-events",
    title: "Creating Multi-Location and Multi-Date Events",
    category: "Events",
    audience: "public",
    description:
      "Learn how multi-location and multi-date event setup helps organizers run recurring series without rebuilding the same event repeatedly.",
    content: `
## Overview

Some events happen more than once or happen in more than one location.

For example, a 6-week beginner series may repeat every quarter and run in two different locations.

Multi-location and multi-date setup helps organizers manage those situations without creating a completely separate event from scratch every time.

## When to use this setup

Use multi-location and multi-date setup when one event concept has multiple schedules.

Examples:

- A 6-week series in Location 1 in January, April, and July
- The same 6-week series in Location 2 on different dates
- A recurring workshop series held in multiple venues
- A repeated group class series with separate location schedules

## Why this is helpful

This setup reduces duplicate work.

Instead of recreating the same event details over and over, the organizer can keep the core event information together and manage separate location schedules.

## What to enter for each location

For each location, enter details such as:

- Location name
- Venue name
- Address
- City, state, and postal code
- Capacity, if needed
- Separate dates and times for that location

## What to enter for each session

Each location can have its own sessions.

A session may include:

- Session date
- Start time
- End time
- Session label
- Series label
- Capacity
- Status

## Best practice

Name locations and series clearly.

Examples:

- Dublin January Series
- Sunbury April Series
- Location 1 Summer Session
- Location 2 Fall Session

Clear naming helps staff, attendees, and organizers understand which schedule they are viewing.
`,
  },
  {
    slug: "duplicating-an-event",
    title: "Duplicating an Event",
    category: "Events",
    audience: "public",
    description:
      "Learn how duplicating an event helps organizers copy event details and avoid recreating complex events manually.",
    content: `
## Overview

Duplicating an event creates a new copy of an existing event.

This is useful when you run similar events, classes, workshops, competitions, or showcases more than once.

## Why duplicate an event

Use duplication when you want to reuse event setup details such as:

- Event name and description
- Event type
- Ticket setup
- Registration settings
- Public visibility settings
- Location or schedule structure
- Branding or event details

## What happens when an event is duplicated

The duplicated event should be a separate event from the original.

The original event should not be overwritten.

The new event will usually be created as a draft or private copy so you can review it before publishing.

## What to review after duplicating

After duplicating an event, review:

- Event name
- Event slug
- Dates and times
- Location details
- Ticket prices
- Capacity
- Public visibility
- Registration deadline
- Event description

## Recommended workflow

After duplicating an event:

1. Open the duplicated copy.
2. Update the name and dates.
3. Confirm the location and ticket information.
4. Review public visibility.
5. Publish when ready.

## Best practice

Use duplicate event for recurring or repeated events, but always review the copy before making it public.

This prevents old dates, prices, or location details from accidentally being reused.
`,
  },
  {
    slug: "selling-tickets-from-admin-side",
    title: "Selling Tickets from the Admin Side",
    category: "Events",
    audience: "public",
    description:
      "Learn how staff can manually record event ticket sales from the workspace side.",
    content: `
## Overview

Admin-side ticket sales allow studio or organizer staff to record event registrations manually.

This is useful when an attendee pays in person, by cash, by check, by Venmo, by Zelle, or through another approved method outside the public checkout flow.

## When to use admin-side ticket sales

Use this workflow when:

- A customer pays at the front desk
- A staff member takes a phone registration
- An attendee pays by cash or check
- A payment is collected through Venmo or Zelle
- The organizer needs to manually add an attendee

## What information to enter

When selling tickets manually, enter:

- Attendee first name
- Attendee last name
- Attendee email
- Ticket type
- Quantity
- Payment amount
- Payment method
- Notes, if needed

## Payment status

If payment has been collected, mark the registration as paid.

If only part of the payment has been collected, use the appropriate partial or unpaid status if available.

## Why accurate entry matters

Manual ticket sales affect:

- Registration counts
- Event attendee lists
- Check-in
- Revenue reporting
- Payment history

Enter the actual payment details carefully so reports stay accurate.

## Best practice

Use notes for anything that staff may need later.

Examples:

- Paid by Venmo
- Paid at front desk
- Comp ticket approved by organizer
- Balance due at door
`,
  },
  {
    slug: "checking-in-event-attendees",
    title: "Checking In Event Attendees",
    category: "Events",
    audience: "public",
    description:
      "Learn how to use event check-in to track attendance for registrations and group class sessions.",
    content: `
## Overview

Event check-in helps staff mark attendees as present when they arrive.

This is useful for workshops, social events, competitions, showcases, and group classes.

## Where to check in attendees

Open the event workspace and go to the Check-In area.

The check-in list shows registered attendees and their current attendance status.

## Basic check-in workflow

On event day:

1. Open the event check-in page.
2. Find the attendee.
3. Confirm their registration or payment status if needed.
4. Mark the attendee as checked in or attended.

## Group class session check-in

Group classes may have multiple class meetings.

For group classes, attendance should be tracked per session when available.

This means a student can attend one class meeting without being marked attended for every class in the series.

## Duplicate check-in protection

DanceFlow is designed to avoid duplicate attendance records for the same attendee and session.

If a staff member tries to check someone in more than once, the system should protect the attendance record from being duplicated.

## Best practice

Before marking attendance, check for:

- Correct event
- Correct date or session
- Correct attendee
- Payment status
- Ticket quantity or registration notes

Accurate check-in helps reporting and attendance history stay useful.
`,
  },
  {
    slug: "dashboard-alerts-and-announcements",
    title: "Understanding Dashboard Alerts and Announcements",
    category: "Platform Updates",
    audience: "public",
    description:
      "Learn how DanceFlow dashboard alerts are used for maintenance notices, feature updates, and important platform announcements.",
    content: `
## Overview

Dashboard alerts and announcements help DanceFlow communicate important information inside the app.

These alerts may appear near the top of a user dashboard when there is something important to know.

## What alerts may be used for

DanceFlow may use dashboard alerts for:

- Scheduled maintenance
- Temporary service issues
- New feature announcements
- Important workflow changes
- Billing or payout reminders
- Known issues and workarounds

## Are alerts permanent?

No.

Alerts are intended to be temporary.

They only appear while active or within the scheduled display window.

## Read more links

Some alerts may include a **Read more** link.

Use that link to open a longer article, announcement, or help guide with additional details.

## Dismissible alerts

Some alerts can be dismissed.

If an alert is dismissible, you can hide it after reading it.

Important alerts, such as maintenance or critical platform notices, may not always be dismissible.

## Best practice

Read dashboard alerts when they appear.

They are designed to help users understand changes, avoid confusion, and stay aware of important platform updates.
`,
  },
  {
    slug: "branded-portal-invite-emails",
    title: "Understanding Branded Portal Invite Emails",
    category: "Client Portal",
    audience: "public",
    description:
      "Learn why portal invite emails include the studio name and logo, and what students or independent instructors should expect.",
    content: `
## Overview

Portal invite emails help students and independent instructors access their DanceFlow portal.

To make these emails easier to recognize, portal invites may include the studio name and studio logo when available.

## Why the studio name appears

The studio name helps the recipient understand who invited them.

Instead of receiving a generic system email, the recipient can see that the invite came from a specific studio through DanceFlow.

## Why the studio logo may appear

If the studio uploaded a public logo, DanceFlow may show that logo in the invite email.

This makes the email feel more familiar and helps the recipient trust that the invite is related to a studio they know.

## Student portal invites

A student portal invite may allow the student to view information such as:

- Lessons
- Packages
- Payments
- Studio updates
- Portal account details

## Independent instructor portal invites

An independent instructor portal invite may allow the instructor to view information such as:

- Host studio schedule activity
- Floor-rental activity
- Related payments or account details
- Studio portal access

## What the recipient should do

The recipient should click **Accept Invite** in the email.

If the button does not work, they can copy and paste the secure invite link into their browser.

## Best practice

Studios should keep their public name and logo updated so invite emails are easy for recipients to recognize.
`,
  },
  {
    slug: "using-danceflow-events-on-your-website-calendar",
    title: "Using DanceFlow Events on Your Website Calendar",
    category: "Events",
    audience: "public",
    description:
      "Learn how to use your DanceFlow website calendar feed so public events can appear on your own website calendar without duplicate entry.",
    content: `
## Overview

DanceFlow can create a public calendar feed for your published events.

This lets you create and update events once in DanceFlow, then show those same events on your own website calendar without entering them twice.

## Quick answer

Copy your **Website Calendar Feed** link from the Events page and paste it into any website calendar or calendar app that supports iCal subscriptions.

## What the calendar feed does

Your calendar feed is a read-only \`.ics\` subscription link.

The feed includes your public DanceFlow events, including:

- Event name
- Date and time
- Location
- Event description
- DanceFlow event page link for details or registration

## Where to find your calendar feed

1. Go to your DanceFlow workspace.
2. Open **Events**.
3. Find the **Website Calendar Feed** card.
4. Click **Copy Link**.
5. Add that link to your website calendar, Google Calendar, Apple Calendar, Outlook, or a supported website calendar plugin.

## What events are included

Only events that are ready for public display are included.

An event must be:

- Published
- Public
- Public directory enabled
- Assigned a start date

Draft, private, and internal-only events are not included in the public website calendar feed.

## How to use it on your website

Use the copied calendar feed link in your website calendar tool or plugin.

Many websites and calendar tools support iCal or \`.ics\` subscription links. Look for options such as:

- Add calendar subscription
- Subscribe to calendar
- Import from URL
- iCal feed
- External calendar URL

Once connected, your website calendar can pull public event updates from DanceFlow.

## Important note about updates

Calendar feeds are not instant.

Your website calendar, calendar app, or calendar plugin decides how often it checks for updates.

If you update an event in DanceFlow, it may take some time before the change appears on your website calendar.

## Why this helps

This lets DanceFlow become your main event management system.

Instead of creating the same event on your website and again in DanceFlow, you can:

1. Create the event in DanceFlow.
2. Publish it.
3. Let your website calendar pull the event from DanceFlow.
4. Send dancers to the DanceFlow event page for details and registration.

## Best practice

Use DanceFlow as the source of truth for event details, registration, ticketing, and check-in.

Use your website calendar as the display layer for visitors who are already browsing your website.
`,
  },
];

export function getPublicKnowledgebaseArticles() {
  return knowledgebaseArticles.filter(
    (article) => article.audience === "public" || article.audience === "both",
  );
}

export function getKnowledgebaseArticleBySlug(slug: string) {
  return knowledgebaseArticles.find((article) => article.slug === slug) ?? null;
}

export function getKnowledgebaseCategories() {
  return Array.from(
    new Set(
      getPublicKnowledgebaseArticles().map((article) => article.category),
    ),
  );
}
