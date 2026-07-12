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

DanceFlow is a dance studio CRM, scheduler, event, and discovery platform built to help studios manage their business while helping dancers find places to dance, people to practice with, events to attend, and dance opportunities.

Most studio tools focus only on internal scheduling or payments. DanceFlow connects both sides of the business:

**Studio operations + public discovery**

That means studios can manage clients, lessons, instructors, packages, memberships, payments, rooms, leads, events, hiring posts, and follow-up while also giving dancers a way to discover studios, events, classes, partner profiles, and job opportunities.

## Who DanceFlow is for

DanceFlow is designed for:

- Ballroom dance studios
- Country dance studios
- Independent dance instructors
- Event organizers
- Dancers looking for partners, events, studios, and dance jobs
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
- Public discovery listings
- Now Hiring job postings
- Event registrations, tickets, and check-in
- Documents and e-signatures
- Event waivers and signed-document receipts
- Wave Accounting connection
- Google Calendar integration
- ARIA revenue insights and automation review tools
- In-person card reader payment workflows

## What dancers can do

Dancers can use DanceFlow to:

- Discover public studio profiles
- Browse events, classes, socials, workshops, and ticketed activities
- Create a dancer-owned Partner Search profile
- Search for dance partners by goals, role, level, location, and styles
- Keep Partner Search conversations inside DanceFlow
- Hide or pause a Partner Search profile anytime
- Browse studio job postings
- Save favorites and return to them later
- Keep event tickets and QR codes in their wallet
- Register for events through the student app when available
- Review required event documents during checkout
- Access studio portals when a studio links them

## What makes DanceFlow different

DanceFlow is built around real studio workflows.

Instead of only acting as a calendar or payment system, DanceFlow helps connect the full path:

**Dancer discovers studio, event, partner, or job → connects through DanceFlow → becomes a lead, attendee, partner match, applicant, or client → stays connected through the portal and app**

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
    slug: "using-partner-search",
    title: "Using Partner Search",
    category: "Discovery",
    audience: "public",
    description:
      "Learn how dancers can create a Partner Search profile, choose goals and styles, and keep communication inside DanceFlow.",
    content: `
## Overview

Partner Search helps dancers find other dancers who are looking for practice, social dance, showcase, or competition partners.

Partner Search is dancer-owned. A studio does not need to create the profile for the dancer.

## Creating a dancer profile

Any logged-in DanceFlow account can create a Partner Search profile.

From the website, go to:

**Account > Partner Search**

From the student app, open:

**Discover > Partners**

Your profile can include:

- Display name
- Headline
- City and state
- Lead, follow, switch, or either role
- Skill level
- Dance style categories and individual dances
- One or more goals
- Bio
- Availability
- Profile photo in the mobile app

## Goals are multi-select

A dancer can select more than one goal.

For example, someone may be open to:

- Practice
- Social
- Showcase
- Competition

Search filters also support multiple goals, so a dancer can look for people who match more than one intent.

## Dance styles and categories

Dance styles use preset choices to reduce typos and search mismatches.

Dancers can select broad categories, individual dances, or both.

Examples:

- American Smooth
- American Rhythm
- International Ballroom
- International Latin
- Country
- Social / Club
- Country Two Step
- West Coast Swing
- Salsa
- Bachata

## Profile visibility

Dancers can hide their Partner Search profile at any time.

Use this if:

- You found a partner
- You want to pause new requests
- You are not currently looking

Hidden profiles do not appear in public Partner Search results.

## Safety and communication

Partner Search is intended for dancers looking for dance partners.

DanceFlow keeps communication inside the platform. Public lesson ads, coaching offers, paid service promotions, outside booking links, phone numbers, emails, and studio promotions are not allowed in Partner Search profiles.
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
    title:
      "Syncing an Instructor Schedule to Google, Apple, or Outlook Calendar",
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

## Ticket codes and QR codes

For ticketed events, DanceFlow can generate a unique ticket code for each attendee.

That code may appear in the attendee confirmation email and in the event registration tools.

At check-in, staff can:

- Search by attendee name, email, or phone
- Enter the ticket code manually
- Scan the attendee QR code when QR scan mode is available

The QR code is tied to the ticket code, so scanning the QR code follows the same check-in rules as entering the code manually.

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

  {
    slug: "using-client-account-credits-and-balances",
    title: "Using Client Account Credits and Balances",
    category: "Clients & Billing",
    audience: "public",
    description:
      "Learn how to add client credits, record balances owed, apply credits to package sales, and keep a truthful account ledger.",
    content: `
## Overview

Client account credits and balances help your studio track money or value that belongs on a client account.

Use this when a client has a credit, owes a balance, has a floor fee charge, overpaid, received a refund credit, or needs an accounting adjustment.

This is different from package count correction. Package count correction changes lesson credits. The account ledger tracks financial value.

## When to use account credit

Use account credit for situations such as:

- A client overpaid
- A client has a refund credit
- A client prepaid for future use
- A studio gives a manual account credit
- A floor fee credit needs to be recorded
- A credit should be applied toward a package or lesson later

## When to add a balance owed

Use a balance owed or charge when the client owes the studio money.

Examples include:

- Floor fee owed
- Pay-as-you-go lesson balance
- Manual balance adjustment
- Other client debt that should remain visible until resolved

## How to add credit or a charge

1. Open the client record.
2. Find **Package Count Correction** and **Account Balance**.
3. Open **Manage Ledger**.
4. Choose the type of credit or charge.
5. Enter the amount and reason.
6. Save the entry.

DanceFlow keeps the original ledger entry instead of changing history.

## How to apply credit to a package sale

When selling a package, DanceFlow can show the client's available account credit.

Enter the amount of credit to apply. The payment due today is reduced by the credit amount.

Example:

- Package price: $300
- Available account credit: $85
- Credit applied: $85
- Payment collected today: $215

DanceFlow records the package sale and creates a ledger entry showing that credit was applied.

## How to apply credit to a pay-as-you-go lesson

During Daily Closeout, a pay-as-you-go lesson may appear under **May Need Review**.

If the client has account credit, apply the credit toward the lesson balance. If the credit covers the full lesson price, the lesson can move to Ready to Close Out without collecting a new payment.

If the credit only covers part of the lesson, collect the remaining amount.

## What students see

Students can see a read-only account balance in their portal when ledger activity exists.

They can view:

- Available credit
- Balance owed
- Net balance
- Recent account activity

Students cannot edit the ledger.

## Important accounting note

Do not use package count correction to represent money.

Use package count correction for lesson/package credit fixes. Use the account ledger for client credit, debt, payments applied, and financial adjustments.
`,
  },
  {
    slug: "managing-daily-closeout-and-lessons-that-need-review",
    title: "Managing Daily Closeout and Lessons That Need Review",
    category: "Scheduling",
    audience: "public",
    description:
      "Understand Daily Closeout, why lessons need review, and how to handle payments, credits, and attendance.",
    content: `
## Overview

Daily Closeout helps studios mark completed lessons as attended after confirming they are properly covered by a package, membership, payment, or comp reason.

Some lessons are ready to close out immediately. Others appear under **May Need Review** because DanceFlow needs staff to resolve payment or credit coverage first.

## Why a lesson may need review

A lesson may appear under May Need Review when:

- It is pay-as-you-go and unpaid
- It is missing a valid package credit
- It has a billing type that needs payment confirmation
- The client has no available credit or package coverage
- Staff need to apply account credit or collect payment

## Ready to Close Out

Lessons are ready to close out when DanceFlow can confirm the lesson is covered.

Examples:

- Package Credit lesson with available package credit
- Membership lesson with valid membership coverage
- Pay-as-you-go lesson marked paid
- Free/Comped lesson with no payment required

## Recording a pay-as-you-go payment

1. Open **Schedule**.
2. Go to the correct date.
3. Find **Lessons that need review**.
4. Open the pay-as-you-go lesson.
5. Enter payment collected, payment method, and any notes.
6. Save the payment.

Once the payment covers the lesson, the lesson can move to Ready to Close Out.

## Applying account credit

If the client has available account credit, you can apply it toward the lesson.

Examples:

- Lesson price: $85
- Available credit: $85
- Credit applied: $85
- New payment collected: $0

Or:

- Lesson price: $100
- Available credit applied: $60
- New payment collected: $40

DanceFlow records the credit application in the client account ledger.

## Closing out the day

Once eligible lessons are ready, use the closeout action to mark them attended.

This updates attendance and helps keep package balances, membership usage, and reports accurate.

## Best practice

Review May Need Review before closing out the day. This keeps attendance, payments, package credits, and account balances accurate.
`,
  },
  {
    slug: "choosing-the-right-lesson-billing-type",
    title: "Choosing the Right Lesson Billing Type",
    category: "Scheduling",
    audience: "public",
    description:
      "Learn when to use Package Credit, Membership, Pay-as-you-go, or Free/Comped billing for lessons.",
    content: `
## Overview

Lesson billing type tells DanceFlow how a scheduled lesson should be covered financially.

Choosing the right billing type makes Daily Closeout easier and helps reports stay accurate.

## Package Credit

Use **Package Credit** when the lesson should deduct from a client package.

Examples:

- Private lesson package
- Group class package
- Practice party package
- Mixed package with eligible credits

If no valid package credit is available, the lesson may appear under May Need Review.

## Membership

Use **Membership** when the lesson or class is covered by an active membership plan.

Examples:

- Monthly group class membership
- Practice membership
- Membership benefit that includes a certain number of lessons or classes

DanceFlow can track membership usage separately from normal package credits.

## Pay-as-you-go

Use **Pay-as-you-go** when the client will pay for that single lesson without using a package or membership.

Unpaid pay-as-you-go lessons appear under May Need Review until staff record payment or apply account credit.

## Free/Comped

Use **Free/Comped** when the lesson should not require payment or package credit.

Examples:

- Complimentary intro lesson
- Staff-approved make-up
- Owner-approved comp
- Promotional lesson

Use notes when possible so the reason is clear later.

## Best practice

Choose the billing type at scheduling time. This prevents confusion during Daily Closeout and helps staff understand what needs payment, credit, or review.
`,
  },
  {
    slug: "selling-guest-coach-private-lesson-slots",
    title: "Selling Guest Coach Private Lesson Slots",
    category: "Events",
    audience: "public",
    description:
      "Set up guest coach availability, generate private lesson slots, and let dancers book paid event coaching times.",
    content: `
## Overview

Guest Coach Private Lesson Slots let studios sell fixed private lesson times with a visiting coach during an event.

This is useful for workshops, intensives, showcases, competitions, and special guest coach weekends.

## How it works

The studio creates a guest coach on the event, adds availability, and DanceFlow generates fixed bookable slots.

Dancers can select an available time from the public event page and pay to reserve the slot.

## Add a guest coach

1. Open the event in your workspace.
2. Edit the event.
3. Find **Guest Coach Private Lessons**.
4. Add the coach name.
5. Optionally add a bio and photo URL.

## Add availability

For each coach, add an availability block.

Include:

- Date
- Start time
- End time
- Lesson length
- Buffer time
- Price
- Location or room label

DanceFlow generates available slots from the block.

## Public booking flow

On the public event page, dancers can:

1. View guest coaches.
2. Expand a coach to see available dates and times.
3. Select a time slot.
4. Enter buyer information.
5. Continue to payment.

Once payment is completed, the slot is booked and no longer appears as available.

## Guest coach schedule link

Each guest coach can have a private read-only schedule link.

The coach can see:

- Event details
- Lesson times
- Booked student names
- Buyer notes
- Location or room
- Payment status

The coach does not receive full studio workspace access.

## Best practice

Use payment required to reserve a slot. This prevents people from taking prime lesson times without committing.
`,
  },
  {
    slug: "adding-an-event-schedule-or-agenda",
    title: "Adding an Event Schedule or Agenda",
    category: "Events",
    audience: "public",
    description:
      "Create an optional public event agenda with schedule items grouped by date for single-day or multi-day events.",
    content: `
## Overview

The Event Schedule card is an optional public agenda for an event.

It is different from event dates and locations. Dates and locations tell people when and where the event happens. The schedule explains what happens during the event.

## Good uses for an event schedule

Use the schedule for:

- Workshop blocks
- Class times
- Social dance times
- Performances
- Breaks
- Check-in windows
- Competition or showcase blocks
- Multi-day event agendas

## Add schedule items

1. Open the event in your workspace.
2. Edit the event.
3. Find **Event Schedule**.
4. Add a schedule item.
5. Enter the date, start time, optional end time, title, and details.
6. Save the event.

Optional fields may include presenter name and room or location label.

## Multi-day schedules

For multi-day events, add items with different dates.

The public event page groups agenda items by day so visitors can quickly understand the schedule.

## When the card appears

The Event Schedule card appears on the public event page only when schedule items exist.

If all schedule items are removed, the card is hidden.

## Best practice

Keep schedule item titles short and practical. Add details only when dancers need extra context.
`,
  },
  {
    slug: "why-my-studio-or-events-do-not-appear-in-public-discovery",
    title: "Why My Studio or Events Do Not Appear in Public Discovery",
    category: "Public Discovery",
    audience: "public",
    description:
      "Learn how subscription status and visibility settings affect whether studios and events appear publicly.",
    content: `
## Overview

Public discovery helps dancers find studios and events in DanceFlow.

A studio or event must be eligible and visible before it appears publicly.

## Subscription access matters

Public discovery is available for studios with active platform access.

If a studio subscription is canceled or inactive, the studio and its events are removed from public discovery.

If the subscription is restarted and access becomes active again, the studio becomes eligible for public discovery again.

## Studio visibility settings

Even with an active subscription, the studio profile must be enabled for public directory display.

If public directory visibility is turned off, the studio will not appear in discovery.

## Event visibility settings

For an event to appear publicly, it generally needs to be:

- Published
- Public
- Public directory enabled
- Connected to an active/trialing studio

Draft, private, internal-only, or hidden events do not appear in public discovery.

## Restarting a subscription

When a canceled studio restarts its subscription, public discovery eligibility is restored.

However, DanceFlow does not need to automatically republish every hidden event. Studio and event visibility settings still control what actually appears.

After restarting, review:

- Public studio profile
- Public event visibility
- Event status
- Public directory settings

## Best practice

Use public visibility intentionally. Keep draft events hidden until they are ready, and review public pages after billing changes.
`,
  },
  {
    slug: "using-expenses-and-floor-fee-expense-tracking",
    title: "Using Expenses and Floor Fee Expense Tracking",
    category: "Reports & Expenses",
    audience: "public",
    description:
      "Track studio expenses and floor fee costs so reporting and profit views are more accurate.",
    content: `
## Overview

The Expenses module lets studios and independent instructors record business expenses in DanceFlow.

This helps reports and P&L views show a more truthful picture of business activity.

## Common expenses

Examples include:

- Floor fees paid to another studio
- Rent
- Supplies
- Event costs
- Marketing expenses
- Contractor or professional fees
- Other business expenses

## Floor fee expenses

Floor fees can mean different things depending on the business.

For an independent instructor renting space, a floor fee paid to another studio is an expense.

For a studio renting out its own space, floor rental fees collected are revenue.

DanceFlow separates these perspectives so floor fees are not blended into generic payments.

## Add an expense

1. Open **Expenses**.
2. Add a new expense.
3. Enter the date, amount, category, vendor or studio name, and notes.
4. Save the expense.

Use clear descriptions so the expense is easy to understand later.

## Best practice

Enter expenses as close to the actual expense date as possible. This helps monthly and year-to-date reporting stay accurate.
`,
  },
  {
    slug: "understanding-basic-profit-and-loss-reports",
    title: "Understanding Basic P&L Reports",
    category: "Reports & Expenses",
    audience: "public",
    description:
      "Learn how DanceFlow uses tracked revenue, refunds, fees, and expenses to build a basic profit and loss view.",
    content: `
## Overview

The basic Profit & Loss report helps studios understand revenue and expenses tracked in DanceFlow.

It is intended as an operational report, not a replacement for professional accounting advice.

## What the report can include

Depending on your setup, the report may include:

- Package revenue
- Lesson payments
- Event or ticket revenue
- Refunds
- Platform or payment-related fees
- Expenses entered in DanceFlow
- Floor fee expense line items

## Floor fee handling

Floor fees should be handled carefully.

If you are an independent instructor paying another studio for floor space, that floor fee is an expense.

If your studio rents out floor space and collects a fee, that collected floor rental fee is revenue.

## Why dates matter

Reports should use the actual sale, payment, or expense date when available.

This keeps the report closer to what really happened in that period.

## Best practice

Use reports to spot trends and review business activity. For taxes, bookkeeping, and official financial statements, work with a qualified accountant or bookkeeper.
`,
  },
  {
    slug: "managing-event-tickets-and-registrations",
    title: "Managing Event Tickets and Registrations",
    category: "Events",
    audience: "public",
    description:
      "Understand the basic event registration workflow, ticket management, admin sales, and check-in.",
    content: `
## Overview

DanceFlow events can support public registration, ticket sales, admin-side ticket sales, and attendee check-in.

This helps studios and organizers manage events without maintaining separate registration lists.

## Basic event setup

Before selling tickets, make sure the event is:

- Published
- Public, if it should appear publicly
- Public directory enabled, if it should appear in discovery
- Connected to ticket types or registration options

## Public registration

Visitors can register or purchase tickets from the public event page when registration is open.

The event page should show event details, dates and locations, ticket options, and any available add-ons or schedule information.

## Admin-side ticket sales

Studios can also sell tickets from the admin/workspace side.

This is helpful when:

- A customer pays in person
- Staff need to register someone manually
- A front desk team is handling event sales

## Managing registrations

Use the registrations area to review attendees, ticket types, registration status, and payment details.

## Check-in

Use check-in when attendees arrive at the event.

Check-in helps the organizer know who attended and supports cleaner event records.

## Best practice

Keep ticket names simple and make sure public pricing and registration deadlines are clear before publishing the event.
`,
  },
  {
    slug: "using-the-student-portal",
    title: "Using the Student Portal",
    category: "Client Portal",
    audience: "public",
    description:
      "Learn what students and clients can see in their DanceFlow portal and how studio portal links work.",
    content: `
## Overview

The student portal gives clients a place to view information connected to their studio relationship.

Depending on what the studio has enabled, a student may see appointments, packages, memberships, balances, event information, and other portal details.

## Portal access

A studio can invite a client to connect their account to the studio portal.

Once connected, the student can sign in and view linked studio information from their account page.

## Multiple studio portals

A student may be linked to more than one studio.

When this happens, the account page can show each linked studio so the student can navigate to the correct portal area.

## Account balance

If the studio uses client account credits or balances, the portal may show a read-only account balance.

Students can see:

- Available credit
- Balance owed
- Net balance
- Recent account activity

Students cannot edit these records.

## Best practice for studios

Make sure client email addresses are accurate before sending portal invites. Use clear studio branding so students understand who invited them and why.
`,
  },
  {
    slug: "privacy-security-and-student-data-basics",
    title: "Privacy, Security, and Student Data Basics",
    category: "Security & Privacy",
    audience: "public",
    description:
      "A practical overview of how studios should think about privacy, student data, payments, and account access.",
    content: `
## Overview

Dance studios manage personal information, payment activity, schedules, and sometimes information related to minors.

Studios should handle that information carefully and only give access to people who need it.

## Payment data

DanceFlow uses Stripe for payment processing. Studios should not collect or store card numbers manually in client notes, messages, spreadsheets, or other unsecured places.

Use approved checkout and payment workflows instead.

## Student and client data

Client information should be used for legitimate studio purposes, such as scheduling, billing, client communication, portal access, and event registration.

Avoid adding sensitive notes unless they are necessary for the studio relationship.

## Minors

Dance studios may work with minors.

As a best practice, minor profiles should be managed by a parent, guardian, studio, or authorized adult. Children under 13 should not create unmanaged DanceFlow accounts.

## Staff access

Only give workspace access to staff who need it.

Use the right role for the person’s responsibilities. Front desk staff, instructors, admins, and owners should not automatically need the same level of access.

## Security best practices

Studios should:

- Use strong passwords
- Avoid sharing accounts
- Remove access when staff leave
- Review public visibility settings
- Keep client information accurate
- Report suspicious activity

## Data requests

Clients may ask about their data, corrections, or deletion. Studios should have a simple process for handling those requests and should contact DanceFlow support when platform assistance is needed.
`,
  },
{
    slug: "using-early-bird-ticket-pricing",
    title: "Using Early Bird Ticket Pricing",
    category: "Events",
    audience: "public",
    description:
      "Learn how to add time-limited early bird pricing to event tickets and how DanceFlow handles the active ticket price.",
    content: `
## Overview

Early bird pricing helps create urgency for event registrations by offering a lower price until a cutoff date and time.

Use early bird pricing when you want dancers to register sooner instead of waiting until the last minute.

## When to use early bird pricing

Early bird pricing works well for:

- Workshops
- Social dance weekends
- Guest coach events
- Camps and intensives
- Competitions and showcases
- Events where you need earlier registration commitments

## How early bird pricing works

Each ticket type can have its own early bird settings.

A ticket can have:

- Regular price
- Early bird price
- Early bird cutoff date and time
- Early bird enabled or disabled

When early bird pricing is active, public event pages and registration forms show the early bird price.

After the cutoff passes, DanceFlow uses the regular ticket price.

## Checkout price protection

The checkout price is calculated by DanceFlow at checkout time.

This means the public page can show the active price, but the server still confirms whether the early bird price is valid before payment is created.

This helps prevent someone from using an outdated page or cart to get an expired discount.

## Best practice

Set the early bird cutoff clearly and leave enough time between the cutoff and the event date.

For example:

- Early bird ends 2 weeks before the event
- Regular pricing continues until sales close
- Ticket sales close shortly before the event or when capacity is reached

Clear pricing helps reduce confusion and support questions.
`,
  },
  {
    slug: "understanding-public-event-pages-and-the-event-cart",
    title: "Understanding Public Event Pages and the Event Cart",
    category: "Events",
    audience: "public",
    description:
      "Learn how public event pages organize event details, tickets, private lessons, schedules, locations, and checkout.",
    content: `
## Overview

Public event pages are designed to help dancers quickly understand an event and take action.

A public event page may include:

- Event overview
- Tickets
- Guest coach private lesson slots
- Event schedule or agenda
- Location details
- Policies and additional details

## Why event pages use tabs

Tabs keep the page easier to read, especially on mobile.

Instead of forcing visitors to scroll through one long page, tabs help them jump directly to the information they care about.

Common tabs include:

- Overview
- Tickets
- Private Lessons
- Schedule
- Location
- Details

## How the event cart works

The event cart keeps track of selected event items.

Depending on the event setup, the cart may include:

- Registration tickets
- Spectator tickets
- Guest coach private lesson slots

The cart helps dancers see what they selected and continue to checkout without losing their place.

## Why the cart stays visible

When an event has multiple tabs, a visitor might add a ticket on one tab and a private lesson on another.

A persistent cart helps keep the checkout path clear.

On desktop, the cart may appear as a side panel.

On mobile, it may appear as a bottom cart bar.

## Best practice

Keep event pages focused on the buyer journey:

- Make the event name, date, and location easy to find
- Put tickets and registration options in a clear place
- Use the schedule tab for agenda details
- Use the details tab for policies, refund notes, and extra information

A clear public event page can turn interest into registrations more effectively.
`,
  },
  {
    slug: "turning-event-registrations-into-crm-leads",
    title: "Turning Event Registrations into CRM Leads",
    category: "Public Discovery & Leads",
    audience: "public",
    description:
      "Learn how studio-owned event registrations can help build your DanceFlow CRM and support follow-up.",
    content: `
## Overview

Event registrations are not just sales.

They can also become useful CRM leads for future follow-up.

When someone registers for a studio-owned event, DanceFlow can connect that person to the studio CRM so the studio can continue the relationship after the event.

## What happens after a studio-owned registration

When a paid registration is confirmed, DanceFlow can:

- Look for an existing client or lead with the same email
- Link the registration to that existing record when found
- Create a new lead when no matching record exists
- Mark the source as an event registration
- Alert the studio that a new event registration lead came in

## Why this matters

Studios often meet new dancers through workshops, socials, camps, and guest coach events.

Capturing those registrants in the CRM helps staff follow up with:

- Trial lesson offers
- Class recommendations
- Package options
- Future events
- Post-event thank-you messages

## Studio-owned events vs organizer-owned events

Studio-owned events can feed the studio CRM.

Organizer-owned events may use a separate organizer contact and audience workflow in a later version.

This separation helps keep studio CRM records and organizer event contacts clean.

## Best practice

After an event, review new event registration leads and decide the next follow-up step.

Useful follow-up ideas include:

- Thank attendees for coming
- Invite them to a related class
- Offer an intro lesson
- Share upcoming events
- Ask for feedback

A good follow-up process helps one-time event attendees become repeat students or clients.
`,
  },
  {
    slug: "creating-a-marketing-campaign",
    title: "Creating a Marketing Campaign",
    category: "Marketing",
    audience: "public",
    description:
      "Learn the basic steps for drafting, previewing, testing, and sending a DanceFlow marketing campaign.",
    content: `
## Overview

Marketing campaigns help studios communicate with leads and clients from inside DanceFlow.

Campaigns can be used for:

- Upcoming event announcements
- Trial lesson follow-up
- Inactive client outreach
- Low package credit reminders
- Class and workshop promotions

## Basic campaign workflow

A simple campaign workflow is:

1. Open Marketing Campaigns.
2. Create a new campaign draft.
3. Choose the campaign audience.
4. Write the subject, preview text, and email body.
5. Preview the audience.
6. Send a test email.
7. Review the final confirmation details.
8. Send the campaign.

## Audience preview

Before sending, review the audience preview.

This helps confirm the campaign is going to the right contacts.

Audience rules may include leads, clients, inactive clients, clients with no upcoming lesson, or clients with low package credits.

## Test emails

Always send a test email before sending to the full audience.

Check:

- Subject line
- Preview text
- Spacing and formatting
- Links
- Call to action
- Footer information

## Consent and unsubscribes

Only send marketing emails to contacts you are allowed to email.

DanceFlow can suppress unsubscribed contacts, but each studio is responsible for using marketing tools responsibly.

Marketing emails should include the studio's required footer information and a clear unsubscribe option.

## Best practice

Keep campaigns focused.

A strong campaign usually has:

- One main message
- One clear call to action
- A simple next step
- A subject line that matches the email content
`,
  },
  {
    slug: "understanding-marketing-audiences",
    title: "Understanding Marketing Audiences",
    category: "Marketing",
    audience: "public",
    description:
      "Learn how DanceFlow marketing audiences help studios send more targeted messages to leads and clients.",
    content: `
## Overview

Marketing audiences help studios send the right message to the right people.

Instead of sending every message to every contact, audiences make campaigns more targeted.

## Examples of useful audiences

Common audiences may include:

- All active clients
- New leads
- Inactive clients
- Clients with no upcoming lesson
- Clients with low package credits
- Event registrants
- Checked-in event attendees

Some audiences may depend on your subscription tier or the features currently enabled in your workspace.

## Why targeted audiences matter

Targeted campaigns usually perform better because the message is more relevant.

For example:

- Low package credit clients may need a package renewal reminder.
- Event registrants may need a post-event follow-up.
- Inactive clients may need a friendly reactivation message.
- Leads may need a clear invitation to schedule their first lesson.

## Audience preview

Before sending a campaign, review the audience preview.

Look for:

- Expected recipient count
- Suppressed or unsubscribed contacts
- Contacts that do not belong in the audience
- Missing contacts that may need updated CRM information

## Best practice

Start with simple audiences.

Once the studio is comfortable, use more specific audiences for better follow-up and stronger conversion.
`,
  },
  {
    slug: "setting-up-team-members-and-front-desk-access",
    title: "Setting Up Team Members and Front Desk Access",
    category: "Getting Started",
    audience: "public",
    description:
      "Learn how studios can think about team access for owners, instructors, admins, and front desk staff.",
    content: `
## Overview

Dance studios often have more than one person helping with daily operations.

A studio may need access for:

- Studio owners
- Admin staff
- Front desk staff
- Instructors
- Independent instructors
- Event staff

## Why role access matters

Not every team member needs the same permissions.

For example, an owner may need billing, reports, settings, and team management.

A front desk staff member may need clients, schedule, check-in, payments, and tickets, but may not need full owner-level settings.

An instructor may need schedule and student information without full billing or admin control.

## Inviting team members

When team invitations are available in your workspace, use the team settings area to invite staff.

Before inviting someone, decide:

- What tasks they need to complete
- Whether they should see financial details
- Whether they should manage events or tickets
- Whether they should access settings
- Whether they should manage clients or only view schedules

## Best practice

Start with the least access someone needs to do their job.

Review team access regularly, especially when staff roles change.

This keeps the workspace cleaner and helps protect client and payment information.
`,
  },
  {
    slug: "using-share-buttons-for-studios-and-events",
    title: "Using Share Buttons for Studios and Events",
    category: "Public Discovery & Leads",
    audience: "public",
    description:
      "Learn how public share buttons can help studios and organizers promote studio profiles and event pages.",
    content: `
## Overview

Public studio and event pages are easier to promote when visitors can share them quickly.

DanceFlow public pages may include share buttons so dancers, studios, and organizers can copy or share the current page link.

## Where share buttons help

Share buttons are useful for:

- Studio profile pages
- Public event pages
- Workshop announcements
- Social dance events
- Competitions and showcases
- Guest coach events

## How sharing works

When supported by the device or browser, the share button can open the native share menu.

This may let someone share the page through text message, email, social apps, or other installed apps.

When native sharing is not available, the page can fall back to copying the link.

## Why this matters

Sharing helps public pages travel beyond the original audience.

A dancer might share an event with a partner.

A studio owner might share a public event page on social media.

An organizer might send the event link directly to instructors, competitors, or attendees.

## Best practice

Before sharing, make sure the public page has the correct:

- Event name
- Date and time
- Location
- Ticket options
- Registration details
- Public visibility settings

A complete public page makes shared links more effective.
`,
  },

  {
    slug: "managing-booking-requests",
    title: "Managing Booking Requests",
    category: "Booking Requests",
    audience: "both",
    description:
      "Learn how public intro requests and portal schedule requests flow into the staff approval queue.",
    content: `
## Overview

Booking requests let studios collect preferred lesson times without allowing visitors or portal clients to place appointments directly on the calendar.

Requests are staff-reviewed. That means the studio stays in control of availability, instructor assignment, room usage, and final scheduling.

## Where booking requests come from

Booking requests can come from:

- Public intro lesson request pages
- Client portal schedule request pages
- Future staff-created request workflows

Public intro requests are usually for new or returning leads. Portal schedule requests are usually for existing clients who already have portal access.

## Where staff reviews requests

Go to **Schedule > Requests**.

The request queue shows pending, approved, declined, and all requests.

Each request includes client/contact details, requested time, source, notes, instructor or room preferences when available, and current status.

## Statuses

Booking requests use these statuses:

- **Pending**: needs staff review
- **Approved**: converted into an appointment
- **Declined**: not scheduled

## Best practice

Review pending requests daily. If a requested time works, approve it and create the appointment. If it does not work, decline it with a note and follow up with the client using another available time.
`,
  },
  {
    slug: "approving-or-declining-booking-requests",
    title: "Approving or Declining Booking Requests",
    category: "Booking Requests",
    audience: "app",
    description:
      "Learn what happens when staff approves or declines a booking request.",
    content: `
## Overview

Approving a booking request creates a confirmed appointment. Declining a request keeps the calendar unchanged and records the staff decision.

## Approving a request

Go to **Schedule > Requests** and open the pending request.

Before approval, review:

- Client name and contact information
- Requested date and time
- Instructor
- Room
- Lesson type
- Notes from the client

When you approve, DanceFlow performs a final conflict check. If the time is still available, the appointment is created and the request is marked approved.

## Declining a request

Decline a request when the requested time or setup does not work.

Add a staff note so your team understands why it was declined. A good note might include a suggested alternate time or a reminder to contact the client.

## What clients see

If email notifications are enabled, clients can receive updates when a request is received, approved, or declined.

## Best practice

Use approval for times you are confident can be honored. Use decline when the client needs a different time, different instructor, or additional follow-up before scheduling.
`,
  },
  {
    slug: "portal-schedule-requests",
    title: "Letting Portal Clients Request Lesson Times",
    category: "Booking Requests",
    audience: "both",
    description:
      "Learn how existing clients can request lesson times from the client portal.",
    content: `
## Overview

Portal schedule requests let existing clients ask for a preferred lesson time from their portal.

This is not instant booking. The studio still reviews and approves the request before an appointment appears on the schedule.

## How clients submit a request

A portal client goes to the schedule area of the client portal and completes the request form.

The request may include:

- Preferred date
- Preferred time
- Lesson type
- Notes for the studio

## How staff handles the request

Staff reviews portal schedule requests from **Schedule > Requests**.

A portal request is labeled separately from a public intro request so the team can understand where it came from.

## Why this is useful

Portal schedule requests reduce back-and-forth messaging while keeping the studio in control.

Clients can communicate preferred times, and staff can approve only the times that work for the instructor, room, and studio calendar.

## Best practice

Use portal schedule requests for existing clients who already understand your studio process. Keep instant booking disabled until your studio has clear availability rules and approval workflows in place.
`,
  },
  {
    slug: "booking-availability-rules",
    title: "Setting Booking Availability Rules",
    category: "Booking Requests",
    audience: "app",
    description:
      "Learn how availability rules control when clients can request lesson times.",
    content: `
## Overview

Booking availability rules control what dates and times clients can request.

These rules help prevent unrealistic requests and make the booking request workflow easier for staff to manage.

## What availability rules can control

Depending on your workspace settings, you may be able to configure:

- Requestable days of the week
- Earliest request time
- Latest request time
- Minimum notice
- How far ahead clients can request
- Bookable instructors
- Bookable lesson types

## Public requests vs portal requests

Public intro booking rules are usually designed for new leads.

Portal schedule request rules are designed for existing clients.

Your studio may choose to allow one, both, or neither.

## Request-based scheduling

Availability rules do not automatically create appointments. They guide the request process and help staff review better requests.

## Best practice

Start with conservative windows. For example, allow requests during your normal front desk hours or high-availability teaching blocks. Expand the request window after your team is comfortable with the workflow.
`,
  },
  {
    slug: "client-photo-verification",
    title: "Adding Client Photos for Staff Verification",
    category: "Clients & CRM",
    audience: "app",
    description:
      "Learn how client photos help staff verify accounts and prepare for future QR check-in workflows.",
    content: `
## Overview

Client photos help staff visually confirm that they are working with the correct client profile.

This is useful at the front desk, during check-in, and when studios have multiple clients with similar names.

## Where photos appear

Client photos can appear on the client profile and may be used in future check-in and QR identity workflows.

If no photo is available, DanceFlow can show an initials fallback.

## Adding a photo

When creating or editing a client, upload a clear headshot. On supported phones or tablets, the file picker may allow staff to take a new photo with the device camera.

## Best practice

Use a clear, well-lit headshot. Avoid group photos, blurry images, or images where the client is difficult to identify.

## Future use

Client photos are part of the foundation for future client QR identity. When staff scans a client QR code, the photo can help verify the client before checking them into lessons, classes, or events.
`,
  },
  {
    slug: "staff-photos-and-credentials",
    title: "Adding Staff Photos and Credentials",
    category: "Public Profile",
    audience: "app",
    description:
      "Learn how to add staff photos, teaching certifications, and titles for instructor profiles.",
    content: `
## Overview

Staff photos and credentials help your studio present instructors professionally.

These details can support both internal staff profiles and public studio marketing.

## Staff photos

Add a clear instructor headshot from the instructor create or edit page. On supported devices, staff may be able to take a photo directly with the camera.

Photos help public visitors recognize instructors and make staff profiles feel more complete.

## Credentials and titles

Credentials can include:

- Teaching certifications
- Judge certifications
- Competitive titles
- Professional achievements
- Specialty training

Examples:

- DVIDA Certified Instructor
- UCWDC Certified Judge
- 2025 UCWDC World Masters Champion
- West Coast Swing Specialist

## Best practice

Use specific credential names and include the issuing organization or event whenever possible. This makes verification easier and gives public visitors clearer information.
`,
  },
  {
    slug: "staff-credential-verification",
    title: "Submitting Staff Credentials for Verification",
    category: "Public Profile",
    audience: "app",
    description:
      "Learn how credential verification works before certifications and titles appear publicly.",
    content: `
## Overview

DanceFlow supports credential verification so public staff profiles can show accurate certifications and achievements.

A studio can submit multiple credentials for one instructor. Each credential is reviewed separately.

## Why credentials are reviewed separately

One instructor may have several certifications or titles, and each may require its own proof.

For example:

- DVIDA Certified Instructor
- UCWDC Certified Judge
- 2025 UCWDC World Masters Champion

Each credential should have its own proof or reference link.

## Credential statuses

Credentials may be:

- **Submitted**: waiting for review
- **Verified**: approved for public display if public display is enabled
- **Rejected**: not approved based on the provided information

## Public display

Only verified credentials that are marked for public display appear on the public studio staff section.

Submitted or rejected credentials remain internal and do not appear publicly.

## Best practice

Add a proof URL or reference that clearly supports the specific credential. Examples include certification records, official results pages, event results, or an uploaded proof document when supported.
`,
  },
  {
    slug: "verified-staff-credentials-on-public-pages",
    title: "How Verified Staff Credentials Appear Publicly",
    category: "Public Profile",
    audience: "public",
    description:
      "Learn how verified staff certifications and achievements can appear on a studio public page.",
    content: `
## Overview

Public staff credentials help dancers understand an instructor's background, training, and achievements.

Studios can submit credentials for verification, and verified credentials can appear in the Staff section of the public studio page.

## What may appear publicly

A public staff profile may include:

- Instructor photo
- Title or role
- Bio
- Specialties
- Verified teaching certifications
- Verified titles or achievements

## Why verification matters

Verification helps protect the credibility of the studio and the platform. Public visitors should be able to trust that displayed certifications and achievements have been reviewed.

## What does not appear publicly

Submitted, rejected, or unverified credentials do not appear publicly by default.

Studios can still view those credentials internally.
`,
  },
  {
    slug: "sms-consent-and-message-history",
    title: "Using SMS Consent and Message History",
    category: "Communication",
    audience: "app",
    description:
      "Learn how to record SMS consent and review message history on a client profile.",
    content: `
## Overview

SMS consent helps your studio track whether a client has agreed to receive text messages.

DanceFlow requires consent tracking so staff can see whether a client is opted in, opted out, or still needs consent.

## Where to manage SMS consent

Open a client profile and go to the Marketing tab.

There you can review or update the client's SMS consent status and consent note.

## SMS statuses

Common statuses include:

- **Consent needed**: no clear SMS permission has been recorded
- **Opted in**: client has agreed to receive texts
- **Opted out**: client should not receive texts

## Message history

The client Marketing tab can show recent SMS message history, including queued, sent, delivered, or failed messages when available.

## Best practice

Only mark a client opted in when the client has clearly agreed to receive SMS messages. If a client replies STOP, keep them opted out unless they later opt back in.
`,
  },
  {
    slug: "sms-opt-in-for-studios",
    title: "What SMS Opt-In Means for Studios",
    category: "Communication",
    audience: "public",
    description:
      "Understand what studios should know before texting clients through DanceFlow.",
    content: `
## Overview

SMS opt-in means a client has agreed to receive text messages from the studio or organizer.

Studios should not text clients who have not given permission.

## What consent should cover

Consent should make it clear that the client may receive text messages about studio-related communication, such as:

- Lesson reminders
- Schedule updates
- Event or registration updates
- Client follow-up
- Account or service communication

## Consent is optional

SMS consent should not be required for a client to receive services, register for an event, or buy a ticket.

Clients can use other communication methods if they do not want text messages.

## Opting out

Clients can opt out of SMS messages by replying STOP. They may reply HELP for help.

## Best practice

Record consent clearly in the client profile. Use notes when helpful, such as how consent was received or who recorded it.
`,
  },
  {
    slug: "documents-and-e-signatures",
    title: "Creating and Sending Documents for E-Signature",
    category: "Documents & E-Signatures",
    audience: "app",
    description:
      "Learn how documents and e-signatures help studios collect agreements, waivers, and acknowledgments.",
    content: `
## Overview

Documents and e-signatures help studios collect important agreements without relying on paper forms.

Common examples include:

- Studio policies
- Liability waivers
- Membership agreements
- Event waivers
- Code of conduct acknowledgments

## Creating documents

Use the Documents area to create reusable document templates for your studio.

Templates can be used for clients, portal users, or event workflows depending on how the document is configured.

## Sending for signature

When a document is sent for signature, the recipient can review and sign the document electronically.

Signed records are saved so staff can verify completion later.

## Best practice

Keep document language clear and specific. If a document is legally important, have it reviewed by an appropriate professional before using it with clients or attendees.
`,
  },
  {
    slug: "finding-signed-documents-and-waivers",
    title: "Finding Signed Documents and Waivers",
    category: "Documents & E-Signatures",
    audience: "app",
    description:
      "Learn where to look when you need to confirm whether a client or event attendee signed a document.",
    content: `
## Overview

Signed documents help staff confirm that required forms have been completed.

This is especially useful for studio waivers, client agreements, event waivers, and membership documents.

## Client documents

Open the client profile and review the Documents area to see documents related to that client.

Look for signed status, completion timestamps, and the document name.

## Event waivers

For events, signed waivers may be tied to the registration or attendee record.

Use the event registration or check-in areas to confirm whether required waivers have been completed.

## Best practice

Before allowing participation in activities that require a waiver, confirm the document status is complete. If a document is missing or unsigned, ask the client or attendee to complete it before participating.
`,
  },

  {
    slug: "student-portal-access-and-sign-in-links",
    title: "How Students Access the Portal",
    category: "Client Portal",
    audience: "app",
    description:
      "Help students and clients sign in to their studio portal using the correct email address and secure sign-in link.",
    content: `
## Overview

Students and clients access their portal with a secure email sign-in link. They do not need a traditional password unless they have created one separately.

Portal access is tied to the email address saved on the client record. The student should use the same email address the studio has on file.

## How to invite a student to the portal

Open the client record, confirm the email address is correct, then use the portal invite option from the client profile.

The student should receive an email or portal link that brings them to the student portal sign-in flow.

## What the student sees

When the student opens a portal link, they may be asked to enter their email address and request a secure sign-in link.

They should enter the same email address listed on their client record.

After they request the link, they should open the newest email and click the secure sign-in link. Older links may expire or stop working after a newer link is requested.

## If the student cannot get in

Check the following:

- The client record has the correct email address.
- The student is entering that exact email address.
- The student is using the newest sign-in email.
- The email did not go to spam or junk.
- The student is opening the link on the same browser/device when possible.

## If the portal still does not open

If the student can sign in but does not see the correct portal, confirm that the client record is linked to the portal user. In normal use, DanceFlow attempts to link the portal account automatically after sign-in when the email matches the client record.
`,
  },
  {
    slug: "resetting-your-password",
    title: "How to Reset Your Password",
    category: "Account Access",
    audience: "both",
    description:
      "Learn how to use the forgot-password flow and create a new password for your DanceFlow account.",
    content: `
## Overview

Use the forgot-password flow when you need to create a new password or cannot access your account.

DanceFlow sends a secure reset email. The newest reset email should be used because older reset links may expire or become invalid.

## Reset your password

From the login page, choose the forgot-password option and enter your account email address.

Open the reset email and click the secure link. You should be taken to the reset password page.

Enter your new password, confirm it, and submit the form.

After the password is updated, return to the login page and sign in with the new password.

## Tips

- Use the newest reset email if you requested more than one.
- Check spam or junk folders if the email does not arrive.
- Make sure you are using the email address connected to your DanceFlow account.
- Reset links are time-sensitive and may only work once.

## If the reset link opens the login page

Request a fresh password reset email and use the newest link. If the issue continues, contact support so the account can be checked.
`,
  },
  {
    slug: "resend-event-ticket-confirmation",
    title: "How to Resend a Ticket Confirmation",
    category: "Events & Ticketing",
    audience: "app",
    description:
      "Resend an event ticket confirmation email when an attendee cannot find their tickets or QR codes.",
    content: `
## Overview

Ticket confirmations help attendees find their event details, ticket information, and QR codes.

Use resend when an attendee says they did not receive the email, deleted it, or needs the ticket confirmation sent again.

## Resend a ticket confirmation

Open the event, then go to the event registrations area.

Find the registration and open the registration detail page.

Use the resend ticket confirmation action.

After resending, review the ticket email status on the registration detail page or the registration list.

## Before resending

Confirm:

- The attendee email address is correct.
- The registration is confirmed or paid, unless your workflow allows otherwise.
- QR tickets have been issued for the registration.
- The attendee is checking the correct inbox.

## If resend fails

Check the registration detail page for ticket email status. Also review notification or outbound delivery history if available.

Common causes include a missing recipient email, invalid email address, missing ticket records, or an email delivery failure.
`,
  },
  {
    slug: "review-event-registration-payment-status",
    title: "How to Review Event Registration Payment Status",
    category: "Events & Ticketing",
    audience: "app",
    description:
      "Use event registration visibility tools to review payment, ticket email, QR ticket, and document status.",
    content: `
## Overview

The event registration pages help staff quickly answer key event operations questions:

- Who registered?
- Who paid?
- How did they pay?
- Were ticket emails sent?
- Were QR tickets issued?
- Are required documents or waivers complete?

## Use the registration list

Open the event and go to Registrations.

Use the visibility sections and filters to review registrations that may need attention.

Common review buckets include:

- Payment review
- Ticket email review
- QR ticket review
- Document review

## Open the registration detail page

Use the detail page when you need more information about one registration.

The detail page shows payment source, payment method, ticket email status, QR ticket status, and document or waiver status.

## Payment source examples

Payment records may show different sources depending on how the registration was collected:

- Stripe checkout
- Manual entry
- External card
- Cash
- Comp

## Best practice

Before the event, review registrations that are unpaid, missing QR tickets, missing ticket emails, or missing required documents.

This helps reduce check-in delays and avoids last-minute registration confusion.
`,
  },
  {
    slug: "manage-guest-coach-lesson-slots",
    title: "How to Manage Guest Coach Lesson Slots",
    category: "Events & Ticketing",
    audience: "app",
    description:
      "Manage guest coach private lesson availability, including blocking and unblocking lesson slots.",
    content: `
## Overview

Guest coach lesson slots let event staff manage private lesson availability connected to an event.

Staff can use coach slot management to block unavailable times, mark offline bookings, and keep coach availability accurate.

## Open coach slot management

From the Events page, choose Manage Coach Slots for the event.

You can also open an event detail page and choose Manage Coach Slots from there.

## Blocking lesson slots

Use blocking when a coach is unavailable, a time is reserved offline, or the event schedule needs a break.

Common reasons include:

- Coach break
- Group class
- Offline/private booking
- Schedule hold
- Unavailable time

## Unblocking slots

If a blocked time becomes available again, return to Manage Coach Slots and unblock the slot.

After unblocking, confirm the public or staff-facing schedule reflects the change.

## Best practice

Review coach slots before publishing or sharing the coach schedule. Recheck availability after offline bookings or schedule changes so attendees do not book unavailable times.
`,
  },

  {
    slug: "in-person-payment-options-and-reader-requirements",
    title: "In-Person Payment Options and Reader Requirements",
    category: "Billing & Payments",
    audience: "public",
    description:
      "Understand the difference between Stripe Dashboard Tap to Pay and DanceFlow-controlled card reader payments.",
    content: `
## Overview

DanceFlow supports in-person payment tracking, but there are two different ways a studio may collect an in-person card payment.

These workflows are not the same. The technology requirements and recordkeeping steps are different.

## Option 1: Stripe Dashboard Tap to Pay

Use this option when the studio wants to accept a card payment using a phone and the Stripe Dashboard mobile app.

This is a useful fallback when the studio does not have a physical Stripe reader yet.

### Technology required

You need:

- A Stripe account connected for the studio
- The Stripe Dashboard mobile app
- A compatible phone
- Tap to Pay availability for the Stripe account and region
- A staff member who can sign in to the correct Stripe account

You do not need a separate physical reader for this option.

### Process

1. Staff opens the Stripe Dashboard mobile app.
2. Staff starts a charge inside Stripe.
3. Staff enters the amount in Stripe.
4. Customer taps their card or mobile wallet on the phone.
5. Stripe processes the payment.
6. Staff returns to DanceFlow and records the sale or payment against the correct client, package, membership, lesson, class, party, or balance.

### Important limitation

Payments taken directly in the Stripe Dashboard app are not started by DanceFlow.

That means DanceFlow does not automatically know what the payment was for. Staff must record the payment in DanceFlow so the client history, package balance, reports, and closeout records stay accurate.

## Option 2: DanceFlow-controlled card reader payment

Use this option when the studio wants to start the sale in DanceFlow and send the payment to a registered Stripe Terminal reader.

This is the recommended workflow for a clean front-desk process because the payment can be automatically tied to the DanceFlow sale.

### Technology required

You need:

- Stripe payout setup completed for the studio
- A supported physical Stripe Terminal reader
- The reader registered in DanceFlow
- The reader powered on and connected to the internet
- Staff access to the DanceFlow payment workflow

Recommended reader types include Stripe Terminal smart readers such as Stripe Reader S700/S710 or BBPOS WisePOS E, depending on availability in your region.

### Process

1. Staff starts the sale in DanceFlow.
2. Staff selects the correct purchase or charge type.
3. DanceFlow sends the payment amount to the registered Stripe reader.
4. Customer taps, inserts, or swipes their card on the reader.
5. Stripe processes the payment.
6. DanceFlow records the payment and links it to the correct sale or balance.

### Best use cases

DanceFlow-controlled reader payments are best for:

- Package payments
- Membership payments
- Appointment or lesson balances
- Client account balances
- Future quick charges for group classes, social parties, practice parties, and floor fees

## Which option should the studio use?

Use Stripe Dashboard Tap to Pay when:

- The studio does not have a physical reader yet
- A quick fallback payment is needed
- Staff are comfortable manually recording the payment in DanceFlow afterward

Use DanceFlow-controlled card reader payments when:

- The studio has a registered Stripe Terminal reader
- Staff need the payment connected to a DanceFlow sale automatically
- The studio wants cleaner reports and less manual reconciliation

## Important distinction

A phone using the Stripe Dashboard app does not act as the reader for a DanceFlow-started payment.

If the payment starts in the Stripe Dashboard app, it is a Stripe Dashboard payment and must be recorded in DanceFlow afterward.

If the payment starts in DanceFlow, it must be sent to a supported registered Stripe Terminal reader.
`,
  },
  {
    slug: "taking-in-person-payments-with-tap-to-pay",
    title: "Taking In-Person Payments with Stripe Dashboard Tap to Pay",
    category: "Billing & Payments",
    audience: "public",
    description:
      "Use Stripe Dashboard Tap to Pay as a fallback phone-based payment option, then record the payment in DanceFlow.",
    content: `
## Overview

Stripe Dashboard Tap to Pay lets a studio accept an in-person card payment using the Stripe Dashboard mobile app and a compatible phone.

This is a fallback process for studios that do not have a physical Stripe Terminal reader yet.

It is not the same as a DanceFlow-controlled reader payment.

## Technology required

Make sure:

- Your studio has completed Stripe payout setup.
- You can sign in to the Stripe Dashboard mobile app.
- Your phone supports Tap to Pay.
- Tap to Pay is available for your Stripe account and region.
- Staff know which DanceFlow sale, client, class, party, package, membership, lesson, or balance the payment belongs to.

A separate physical card reader is not required for Stripe Dashboard Tap to Pay.

## Process

1. Open the Stripe Dashboard mobile app.
2. Start a new payment or charge.
3. Enter the amount due.
4. Choose Tap to Pay when available.
5. Ask the customer to tap a contactless card or mobile wallet on the phone.
6. Wait for payment confirmation in Stripe.
7. Return to DanceFlow.
8. Record or confirm the payment against the correct DanceFlow record.

## What to record in DanceFlow

After the Stripe payment succeeds, open the correct area in DanceFlow:

- Client profile for general client payments
- Quick Sale & Payment for package sales or package payments
- Memberships for membership payments
- Schedule or Daily Closeout for lesson balances
- Payments page for ad hoc payments
- Event or door-sale tools for event-related payments, when available

Use:

- Payment method: Card
- Payment channel/source: In-person or Tap to Pay, when available
- Notes: Stripe Dashboard Tap to Pay

## Why a DanceFlow record is still needed

A payment taken directly in the Stripe Dashboard app is not started by DanceFlow.

DanceFlow does not automatically know whether the payment was for a group class, social party, package, membership, lesson, event, floor rental, or client balance.

Recording the payment in DanceFlow keeps:

- Client history accurate
- Package and membership records accurate
- Payment reports accurate
- Front desk closeout cleaner
- Future accounting exports more reliable

## Best practice

For busy front desk payments, write down or immediately select the reason for the charge before using Tap to Pay.

After the payment succeeds, record it in DanceFlow right away so the studio does not have to reconcile unmatched Stripe charges later.
`,
  },
  {
    slug: "registering-a-stripe-card-reader",
    title: "Registering a Stripe Card Reader in DanceFlow",
    category: "Billing & Payments",
    audience: "app",
    description:
      "Create a Terminal location, register a Stripe reader, and refresh reader status from the Billing & Payouts page.",
    content: `
## Overview

DanceFlow-controlled in-person payments require a supported physical Stripe Terminal reader.

Registering the reader lets DanceFlow send a payment amount to the reader, collect the card-present payment, and connect the result back to the correct DanceFlow sale or payment record.

If your studio is only using Stripe Dashboard Tap to Pay, you do not need to register a reader in DanceFlow. Dashboard Tap to Pay is handled inside the Stripe Dashboard mobile app and must be recorded in DanceFlow afterward.

## Technology required

To use DanceFlow-controlled reader payments, make sure:

- Stripe payout setup is complete for the studio.
- The studio has a supported Stripe Terminal reader.
- The reader is powered on.
- The reader is connected to the internet.
- The reader shows a registration code.
- You have permission to manage billing or payment settings.

Recommended reader types include Stripe Terminal smart readers such as Stripe Reader S700/S710 or BBPOS WisePOS E, depending on availability in your region.

## Create or confirm the Terminal location

1. Go to Settings.
2. Open Billing & Payouts.
3. Find In-person payments or Card readers.
4. Create or confirm the studio Terminal location.

The Terminal location tells Stripe where the reader belongs.

## Register the reader

1. On the reader, find the registration code.
2. In DanceFlow, enter the registration code.
3. Add a clear label for the reader, such as Front Desk Reader.
4. Submit the registration.
5. Refresh the reader list.

After registration, the reader should appear in the DanceFlow reader list.

## Reader labels

Use labels that staff can recognize quickly.

Examples:

- Front Desk Reader
- Studio A Reader
- Event Door Reader
- Mobile Reader

## Troubleshooting

### The reader does not appear

Refresh the reader list. Confirm the reader is online and that the registration code was entered correctly.

### The registration code expired

Generate a new registration code on the reader and try again.

### The studio is not ready for reader setup

Complete Stripe payout setup first, then return to Billing & Payouts.

### Staff are trying to use a phone as the DanceFlow reader

A phone running the Stripe Dashboard app cannot act as the reader for a DanceFlow-started payment.

For DanceFlow-controlled payments, use a supported registered Stripe Terminal reader.

## Best practice

Register one front desk reader first and test it before adding multiple readers. Keep reader labels simple so front desk staff can choose the right device during payment collection.
`,
  },
  {
    slug: "collecting-in-person-card-payments-in-danceflow",
    title: "Collecting In-Person Card Payments in DanceFlow",
    category: "Billing & Payments",
    audience: "app",
    description:
      "Use a registered Stripe reader to collect an in-person payment and attach it to the correct DanceFlow payment record.",
    content: `
## Overview

DanceFlow's in-person card payment flow lets staff start a sale in DanceFlow, send the amount to a registered Stripe reader, and automatically connect the successful payment to the correct DanceFlow record.

This is different from Stripe Dashboard Tap to Pay.

With Stripe Dashboard Tap to Pay, staff starts the payment in the Stripe mobile app and records the payment in DanceFlow afterward.

With DanceFlow-controlled payments, staff starts the payment in DanceFlow and the customer pays on the registered reader.

## Technology required

To collect a DanceFlow-controlled in-person card payment, the studio needs:

- Completed Stripe payout setup
- A supported physical Stripe Terminal reader
- The reader registered in DanceFlow
- The reader online and available
- A DanceFlow payment workflow, such as package sale, lesson balance, client balance, or quick charge when available

## Linked payment process

Use this process for payments that must attach to a specific client, package, membership, appointment, or balance.

1. Open the payment workflow in DanceFlow.
2. Confirm the client, amount, and purchase type.
3. Choose In-person card reader.
4. Select the registered reader, if prompted.
5. Start card collection.
6. Ask the customer to tap, insert, or swipe their card on the reader.
7. Refresh the status after the payment is completed, if needed.
8. Confirm the payment shows as paid in DanceFlow.

For a package sale, the package can become active after payment succeeds.

## Quick charge process

Quick Charge is intended for fast front desk charges such as group class drop-ins, social party entrances, practice parties, floor fees, and other ad hoc charges.

The intended flow is:

1. Staff opens Quick Charge.
2. Staff taps a preset charge such as Group Class or Social Party.
3. DanceFlow sends the payment to the default registered reader.
4. Customer pays on the reader.
5. DanceFlow records the payment automatically.
6. Staff is ready for the next person.

Quick Charge may be expanded separately from linked package or membership payments because door-sale payments need fewer steps.

## Canceling a payment attempt

If the customer changes their mind, the reader is unavailable, or the wrong payment was started, use the cancel option before trying again.

## Best practice

Use DanceFlow-controlled reader payments when you want the payment automatically connected to DanceFlow.

Use Stripe Dashboard Tap to Pay only as a fallback when there is no registered reader available, and remember to record the payment in DanceFlow afterward.
`,
  },
  {
    slug: "using-aria-revenue-insights",
    title: "Using ARIA Revenue Insights",
    category: "AI & Automations",
    audience: "app",
    description:
      "Learn how ARIA helps studios find revenue opportunities, follow-up priorities, and event closeout risks.",
    content: `
## Overview

ARIA is DanceFlow's AI Revenue Insights Assistant.

ARIA helps studio owners and staff review the opportunities already visible in DanceFlow, such as low package balances, clients with no upcoming lesson, first-lesson follow-ups, pending booking requests, unsigned documents, and event profitability concerns.

## What ARIA can help surface

ARIA may highlight items such as:

- Clients close to running out of package credits
- Clients who have no future lesson scheduled
- New leads or booking requests that need follow-up
- First-lesson clients who should receive a follow-up message
- Events with unpaid, pending, refunded, or risky closeout data
- Events that may be ready for settlement review

## Using ARIA goals

ARIA goals help you focus the assistant around a business outcome.

Examples:

- Grow package renewals
- Improve client retention
- Fill group classes
- Increase event revenue
- Follow up with inactive clients

After choosing a goal, review the suggested actions and decide which ones your team should handle first.

## What ARIA does not replace

ARIA is a decision-support tool. It does not replace the studio owner's judgment, staff follow-up, or professional accounting advice.

Use ARIA to find priorities faster, then review the underlying client, schedule, payment, or event records before acting.

## Best practice

Review ARIA at the start of the day or week. Use it as a quick revenue and retention checklist before moving into normal front desk work.
`,
  },
  {
    slug: "using-automations-for-client-follow-up",
    title: "Using Automations for Client Follow-Up",
    category: "AI & Automations",
    audience: "app",
    description:
      "Set up automation rules for low package balances, no upcoming lessons, pending booking requests, unsigned documents, and first-lesson follow-up.",
    content: `
## Overview

Automations help studios spot follow-up opportunities without manually searching every client record.

An automation can create a suggested action when a client or workflow needs attention.

## Common automation rules

DanceFlow automations may include:

- Low package balance renewal
- No upcoming lesson
- Pending booking request
- Unsigned document
- First lesson follow-up

## How to use automation drafts

When an automation creates a suggested action, review the draft or task before contacting the client.

Check:

- The client record
- Package or membership status
- Upcoming schedule
- Recent communication
- Whether the suggested message still makes sense

## Manual review matters

Automations are meant to help staff notice opportunities. They should not replace human review, especially when the client has special circumstances or recent conversations.

## Best practice

Start with a small number of automations. Review the results regularly, adjust thresholds when needed, and make sure staff know who is responsible for follow-up.
`,
  },
  {
    slug: "event-profitability-and-closeout-review",
    title: "Reviewing Event Profitability and Closeout",
    category: "Events & Ticketing",
    audience: "app",
    description:
      "Use event profitability, refunds, fees, expenses, labor, and check-in data to review an event before settlement.",
    content: `
## Overview

Event profitability helps studios and organizers understand how an event performed financially.

The closeout view brings together revenue, refunds, fees, expenses, labor, registrations, and check-in activity so staff can review the event before marking it settled.

## What to review

Before settling an event, review:

- Gross ticket revenue
- Refunds
- Processing or platform fees
- Net ticket revenue
- Event expenses
- Event labor costs
- Total event costs
- Final profit or loss
- Paid, unpaid, pending, and refunded registrations
- Ticket check-ins

## Why closeout matters

Closeout creates a final review point so the studio or organizer can catch missing expenses, late refunds, unpaid registrations, or labor costs before relying on the event numbers.

## When an event needs attention

An event may need review when:

- Registrations are unpaid or pending
- Refunds were issued
- Payments exist without complete fee details
- No expenses or labor were entered
- Profit appears unusually high or low
- Check-in activity does not match expected attendance

## Best practice

Do not settle an event until revenue, refunds, fees, labor, and expenses have been reviewed. Add closeout notes when something unusual happened so the history remains understandable later.
`,
  },
  {
    slug: "using-event-qr-tickets-and-scan-check-in",
    title: "Using Event QR Tickets and Scan Check-In",
    category: "Events & Ticketing",
    audience: "app",
    description:
      "Issue QR tickets, resend confirmations, and use QR scanning or manual lookup at event check-in.",
    content: `
## Overview

Event QR tickets help staff check attendees in quickly while keeping registration records connected to ticket codes.

Each attendee can have a unique ticket or check-in code. When QR codes are enabled, the code can appear in the ticket confirmation email and on admin registration tools.

## Before the event

Review registrations before event day:

- Confirm paid or approved registrations
- Resend missing ticket confirmations if needed
- Check that QR tickets were issued
- Review unpaid, pending, or refunded registrations
- Confirm required waivers or documents are signed when applicable

## Check in with QR scan mode

At the event:

1. Open the event check-in page.
2. Choose scan mode when available.
3. Scan the attendee QR code.
4. Confirm the attendee details.
5. Mark the attendee checked in.

## Manual lookup

If a QR code cannot be scanned, staff can search by attendee name, email, phone, or ticket code.

## Duplicate check-in protection

If an attendee is already checked in, DanceFlow should help prevent duplicate attendance records.

## Best practice

Have a backup manual lookup process ready in case a phone camera, browser permission, or attendee email causes trouble at the door.
`,
  },
  {
    slug: "using-event-waivers-and-e-signatures",
    title: "Using Event Waivers and E-Signatures",
    category: "Documents & E-Signatures",
    audience: "both",
    description:
      "Collect signed waivers or required documents during event registration and review signature status before check-in.",
    content: `
## Overview

Event waivers and e-signatures help studios and organizers collect required agreements before participation.

A waiver or document may be connected to an event registration so attendees can sign electronically before the event.

## When to use event waivers

Use event waivers for:

- Workshops
- Social dance events
- Competitions
- Showcases
- Guest coach weekends
- Physical activity releases
- Photo or video releases
- Event policies or conduct agreements

## What attendees do

When a waiver is required, the attendee reviews the document and signs electronically. The signed record is saved so staff can verify completion.

## Where staff checks waiver status

Staff can review signed document status from event registration, check-in, or document-related areas when available.

Before event day, look for attendees who are missing required signatures.

## Best practice

Use clear waiver names and keep the document language specific to the event. If a waiver has legal importance, have the language reviewed by a qualified professional before using it.
`,
  },
  {
    slug: "organizer-contacts-and-event-audiences",
    title: "Using Organizer Contacts and Event Audiences",
    category: "Marketing",
    audience: "app",
    description:
      "Understand how organizer event registrations can become useful contact records for future event communication.",
    content: `
## Overview

Organizer contacts help event organizers keep track of people who register for events, attend events, or interact with organizer-run event pages.

This gives organizers a cleaner way to understand their event audience over time.

## What organizer contacts are useful for

Organizer contacts can support:

- Future event announcements
- Attendee follow-up
- Repeat attendee tracking
- Event-specific audience review
- Revenue and registration summaries

## Studio CRM vs organizer contacts

Studio CRM records and organizer contacts should stay separate when the business workflows are different.

A studio-owned event may feed the studio CRM. An organizer-owned event may feed organizer contact and audience tools.

This separation helps avoid mixing a studio's client list with an organizer's event audience.

## Best practice

After an event, review attendee contacts and decide whether to send a thank-you message, future event announcement, or feedback request.
`,
  },
  {
    slug: "using-client-identity-and-qr-verification",
    title: "Using Client Identity and QR Verification",
    category: "Client Portal",
    audience: "app",
    description:
      "Understand how client identity, headshots, packages, memberships, and future QR check-in workflows work together.",
    content: `
## Overview

Client identity tools help staff verify the correct client before handling check-in, package balances, membership status, or account activity.

A client identity page or QR identity workflow can show important client details in one place.

## What staff may see

Depending on setup, staff may see:

- Client name
- Client photo or initials
- Membership status
- Active package balances
- Upcoming lessons or eligible check-ins
- Account or balance notes

## Why photos help

A clear client photo helps front desk staff and instructors confirm they are working with the right person, especially when clients have similar names.

## Future QR check-in use

Client identity and QR verification are part of the foundation for faster check-ins for lessons, group classes, memberships, and events.

## Best practice

Add client photos when possible and keep package and membership records current. Accurate records make QR verification more useful when check-in workflows expand.
`,
  },


  {
    slug: "current-danceflow-capabilities",
    title: "Current DanceFlow Capabilities",
    category: "Getting Started",
    audience: "public",
    description:
      "A current overview of the major DanceFlow tools available for studios, organizers, instructors, and students.",
    content: `
## Overview

DanceFlow continues to grow into an all-in-one operating system for dance studios, event organizers, instructors, and dancers.

This article gives a current high-level view of the major capabilities available across the platform.

## Studio CRM and client management

Studios can manage clients, leads, client profiles, portal access, notes, photos, packages, memberships, account balances, documents, payments, and relationship history.

This helps studios keep client information in one place instead of spreading it across spreadsheets, payment apps, inboxes, and paper notes.

## Scheduling and daily operations

DanceFlow supports private lessons, instructor schedules, room and floor-space management, booking requests, appointment details, billing type selection, Daily Closeout, attendance, and schedule review.

Studios can use these tools to keep daily operations organized and reduce front desk confusion.

## Packages, memberships, and account balances

DanceFlow supports prepaid packages, recurring memberships, package credit tracking, count corrections, account credits, balance owed entries, and account ledger activity.

This helps studios understand what a client has purchased, what remains, and whether a payment or credit needs attention.

## Payments and in-person card reader workflows

DanceFlow supports online payments through Stripe and in-person card reader workflows through Stripe Terminal.

Studios can use these payment tools for package sales, membership payments, event registrations, client balances, and other approved payment workflows.

## Events, tickets, and check-in

DanceFlow events can include public event pages, ticket types, early bird pricing, registration windows, attendee records, QR tickets, confirmation emails, check-in tools, event schedules, private lesson slots, event documents, and event closeout review.

This helps studios and organizers manage events from listing to registration to event-day check-in.

## Documents and e-signatures

DanceFlow includes document templates, version history, required event documents, electronic signature capture, signed-document receipts, audit information, and downloadable signed-document proof.

Studios and organizers can use documents for waivers, agreements, policies, event forms, and other acknowledgments.

## Public discovery

DanceFlow public discovery helps dancers find studios, events, Partner Search profiles, and Now Hiring listings.

Public discovery is controlled by visibility settings so studios and organizers can decide what should appear publicly.

## Student app and wallet

The DanceFlow student app supports public discovery, event registration, native in-app event payments, wallet tickets, QR codes, schedule visibility, learning content, and student-facing portal-style workflows.

The app is designed to help dancers keep important dance information in one place.

## Partner Search and Now Hiring

Partner Search lets dancers create opt-in profiles for finding practice, social, showcase, or competition partners.

Now Hiring lets studios publish dance job opportunities such as instructor, coaching, front desk, event staff, admin, or other studio roles.

## Accounting and integrations

DanceFlow includes Wave Accounting integration for connected studios, along with Stripe payment foundations and Google Calendar integration.

The long-term direction is an Integration Hub that makes external connections easier to manage and audit.

## ARIA and AI-assisted workflows

ARIA is DanceFlow's AI Revenue Insights Assistant. ARIA helps surface follow-up opportunities, low package balances, inactive clients, event closeout concerns, revenue opportunities, and operational review items.

AI-assisted workflows are designed to support owner and staff decisions, not replace human judgment.

## Security and privacy

DanceFlow has gone through multiple security hardening passes covering authentication redirects, uploads, public pages, payments, webhooks, mobile APIs, bot protection, rate limiting, OAuth, error handling, public data minimization, and production security checks.

For a plain-English overview, read the article called **How DanceFlow Protects Your Studio, Students, Events, and Business Data**.

## What to do next

New users should start with the getting-started checklist, complete public profile settings, add clients or events, connect payouts if collecting payments, and review the relevant knowledgebase articles for the workflows they plan to use first.
`,
  },

  {
    slug: "how-danceflow-protects-your-data",
    title: "How DanceFlow Protects Your Studio, Students, Events, and Business Data",
    category: "Security & Privacy",
    audience: "public",
    description:
      "A plain-English overview of the security protections DanceFlow uses to help protect studio, student, event, payment, and business data.",
    content: `
## Overview

DanceFlow is built for dance studios, organizers, instructors, and dancers. Because DanceFlow supports client records, schedules, payments, documents, event registrations, public listings, and business workflows, security is treated as an ongoing product priority.

This article explains the protections DanceFlow has in place in plain language. It is written to help studio owners, organizers, staff, and students understand the steps DanceFlow takes to reduce common risks.

No software platform can eliminate every possible risk, but DanceFlow is actively hardened to help protect your studio, your students, your events, and your business data.

## Secure sign-in and account access

DanceFlow uses authenticated access for studio workspaces, organizer tools, student portals, and mobile app features.

**What this helps protect against:** People accessing private studio, client, student, event, billing, or schedule information without signing in.

## Safer sign-in links and redirects

DanceFlow validates where users are sent after login, signup, logout, password reset, and secure email sign-in flows.

**What this helps protect against:** Unsafe links that try to trick someone into signing in and then sending them to a malicious website.

## Role-based permissions

DanceFlow checks user roles before allowing access to sensitive tools such as billing, reports, exports, payments, client records, schedule management, event tools, and settings.

**What this helps protect against:** Staff, instructors, or other users seeing or changing information outside their responsibilities.

## Studio and workspace separation

DanceFlow checks that clients, appointments, payments, packages, memberships, documents, reports, and exports belong to the correct studio or workspace before showing or updating them.

**What this helps protect against:** One studio or workspace accidentally accessing another studio's private business information.

## Student portal ownership checks

DanceFlow verifies that a signed-in student is connected to the correct client record, portal, schedule item, document, ticket, payment request, or event order.

**What this helps protect against:** A student viewing or changing another student's schedule, documents, tickets, wallet items, or portal information.

## Mobile app ownership checks

DanceFlow mobile app routes validate the signed-in user before returning schedule, wallet, ticket, event order, partner message, or self-service booking information.

**What this helps protect against:** Mobile users accessing records that do not belong to them.

## Public data minimization

DanceFlow public pages, public discovery, website embeds, and public calendar feeds are designed to show only information intended for public viewing.

**What this helps protect against:** Internal notes, draft content, private listings, unpublished events, inactive listings, or non-public descriptions appearing publicly.

## Public calendar and website embed protection

DanceFlow website calendar feeds and embed tools only include eligible public events from active workspaces and return limited event details.

**What this helps protect against:** Hidden events, inactive studio listings, private event information, or internal event copy leaking through calendar feeds or website embeds.

## Secure payment processing

DanceFlow uses Stripe for online payments, in-app payments, subscriptions, event tickets, and in-person card reader workflows. DanceFlow verifies payment results before marking related records as paid or complete.

**What this helps protect against:** Fake payment confirmations, unpaid access being granted by mistake, mismatched payment amounts, or incorrect payment status updates.

## Stripe webhook protection

DanceFlow verifies Stripe webhook signatures and checks payment details before updating registrations, tickets, subscriptions, orders, packages, memberships, or payment records.

**What this helps protect against:** Forged payment events, incorrect payment updates, duplicate processing, or records being marked paid without a verified payment.

## In-person card reader checks

DanceFlow validates in-person card reader payment sessions before completing payment records.

**What this helps protect against:** Stale reader sessions, mismatched amounts, duplicate processing, or a payment being attached to the wrong record.

## Event ticketing and registration controls

DanceFlow checks event visibility, registration windows, ticket availability, capacity, required documents, and payment status during event checkout.

**What this helps protect against:** Oversold events, expired checkout attempts, private event exposure, invalid ticket purchases, or missing required documents.

## Document and e-signature records

DanceFlow stores signed document details such as signer name, signer email, timestamp, accepted document text, consent language, and audit information.

**What this helps protect against:** Unclear document history, accidental overwriting of signed versions, missing proof of acceptance, or confusion about what was signed.

## File upload validation

DanceFlow validates uploaded files by type, size, extension, and expected content patterns.

**What this helps protect against:** Unsafe or unexpected files being uploaded as client photos, instructor photos, event images, public profile images, imports, or other assets.

## Form validation

DanceFlow validates important form inputs such as names, emails, phone numbers, dates, IDs, notes, statuses, and public settings before saving them.

**What this helps protect against:** Broken records, malformed submissions, accidental bad data, and some common abuse attempts.

## Bot and spam protection

DanceFlow uses rate limits, form validation, honeypot fields, timing checks, and abuse checks on public forms and messaging surfaces.

**What this helps protect against:** Spam submissions, automated form abuse, fake leads, message flooding, and public form attacks.

## Rate limiting on high-risk actions

DanceFlow limits repeated attempts on sensitive actions such as login, checkout, billing, SMS, student app requests, partner messages, AI actions, and public forms.

**What this helps protect against:** Brute-force attempts, repeated checkout abuse, message spam, and automated abuse.

## Safer error messages

DanceFlow avoids showing sensitive system, database, payment provider, SMS provider, OAuth, or webhook details in user-facing error messages.

**What this helps protect against:** Attackers learning internal system details from public error messages.

## OAuth connection protection

DanceFlow protects Google Calendar and Wave Accounting connections with OAuth state validation and encrypted token storage.

**What this helps protect against:** Unauthorized account linking, stolen connection attempts, and exposure of integration access tokens.

## Scheduled job and callback protection

DanceFlow protects scheduled jobs, notification routes, SMS callbacks, and other sensitive background routes with shared secrets or verified provider requests.

**What this helps protect against:** Unauthorized systems triggering private background jobs or fake provider callbacks.

## Browser security headers

DanceFlow uses browser security headers to reduce common web risks.

**What this helps protect against:** Certain browser-based attacks such as content-type confusion, unsafe framing, broad browser permissions, and unintended cross-site behavior.

## SMS consent checks

DanceFlow checks SMS opt-in status before sending text messages and protects delivery status callbacks with a secret.

**What this helps protect against:** Unauthorized texting, accidental messaging without consent, and fake delivery updates.

## Public partner and job listing controls

DanceFlow public Partner Search and Now Hiring areas use published/active listing rules and controlled public fields.

**What this helps protect against:** Hidden, disabled, or inappropriate listings appearing publicly.

## AI and automation safeguards

DanceFlow uses role checks, rate limits, and review-oriented workflows around AI-assisted business tools.

**What this helps protect against:** Uncontrolled automation, excessive AI requests, or AI tools acting outside allowed workspace context.

## Ongoing security improvements

Security is not a one-time project. DanceFlow continues to improve protections as the product grows.

Planned security maturity improvements include:

- Stronger distributed rate limiting across production infrastructure.
- Additional security audit logging for sensitive business actions.
- Pen-test style reviews of high-risk routes and workflows.
- Continued review of public pages, exports, payments, documents, integrations, and mobile APIs.

## What this means for your studio

DanceFlow is designed to help protect your studio operations, student information, event registrations, payments, documents, and public listings.

The goal is simple: keep the right information available to the right people, reduce common security risks, and continue improving safeguards as DanceFlow grows.
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



