---
title: "Importing Client Data from a CSV"
slug: importing-client-data-from-a-csv
category: "Getting Started"
summary: "Learn how to upload, review, and execute a client CSV import in DanceFlow."
order: 40
visibility: public
---

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

First name and last name are required on every row. Email is optional, but if a client does not have an email address, they may not be able to use portal access until one is added.

## Step 1: Open the import page

From your studio dashboard, go to:

**Settings > Import existing data**

## Step 2: Upload your CSV file

Choose the client import option.

Select your CSV file.

The import mode is under **Advanced import behavior**, in **How should this run?**.

**Dry Run** is the default. Uploading and reviewing add nothing, but clicking **Execute Client Import** adds and updates clients even on a Dry Run batch, so do not click it until you are ready.

Use **Create or Update** when you are ready to add or update client records.

Click **Review Clients File**.

## Step 3: Review the uploaded file

After the file uploads, find it in Recent Imports.

Click **Review Clients File**.

DanceFlow will check the file for common problems before importing.

## Step 4: Fix any errors

If DanceFlow finds problems, review the error message and update your CSV.

Common issues include:

- Missing required fields
- Duplicate emails
- Incorrect column names
- Blank rows
- File saved in the wrong format

After fixing the CSV, upload it again and review it.

## Step 5: Execute the import

Once the file review passes, open the review page.

Click **Execute Client Import**.

DanceFlow will add the valid client records to your studio.

## Step 6: Confirm the import

Go to **Clients** and confirm the new clients appear.

Check a few imported client records to make sure names, email addresses, and phone numbers imported correctly.

## Common troubleshooting

### The file uploads, but no clients appear

Uploading only creates an import batch. You still need to review and execute the import.

Go to Recent Imports, click **Review Clients File**, then open the review page and execute the import.

### The review says the CSV could not be reviewed

The system could not validate the file. This may happen if the file cannot be read or there is a permission problem.

Make sure the file is a CSV, check that the column headers are correct, remove blank header columns, save the file again as CSV, and upload it again.

### Some rows imported, but others did not

DanceFlow imported valid rows and skipped or failed rows with problems.

Open the import review and check row-level errors. Correct the failed rows in the CSV, then upload a corrected file.

### Duplicate clients appear

The file may contain repeated emails, or the existing client did not match the imported row.

Use email addresses as the main identifier, remove duplicate rows from the CSV, and use Create or Update mode when updating existing client records.

### Independent instructor clients imported as regular clients

The client import does not set Independent Instructor access.

## Best practices

- Review the uploaded file before you click **Execute Client Import**.
- Start with a small test file before importing a large list.
- Keep a backup of your original CSV.
- Review imported clients before inviting them to the portal.
- Do not import old or unverified email addresses without checking them first.
