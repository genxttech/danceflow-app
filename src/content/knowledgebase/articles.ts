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
];

export function getPublicKnowledgebaseArticles() {
  return knowledgebaseArticles.filter(
    (article) => article.audience === "public" || article.audience === "both"
  );
}

export function getKnowledgebaseArticleBySlug(slug: string) {
  return knowledgebaseArticles.find((article) => article.slug === slug) ?? null;
}

export function getKnowledgebaseCategories() {
  return Array.from(
    new Set(getPublicKnowledgebaseArticles().map((article) => article.category))
  );
}