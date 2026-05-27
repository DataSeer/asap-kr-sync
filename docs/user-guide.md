# ASAP KR-Sync User Guide

## Welcome to KR-Sync

KR-Sync is a web application designed to help you manage Key Resource Tables (KRT) for scientific manuscripts. This guide will walk you through everything you need to know to use the application effectively.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Understanding the Workflow](#understanding-the-workflow)
3. [Step 1: Upload Your KRT](#step-1-krt-management)
4. [Step 2: PDF Analysis](#step-2-pdf-analysis)
5. [Step 3: Review Changes (view-only)](#step-3-final-review)
6. [Step 4: Edit the Availability Statement](#step-4-edit-the-availability-statement)
7. [Step 5: Generate Report](#step-5-report-generation)
8. [Managing Your Submissions](#managing-your-submissions)
9. [User Roles](#user-roles)
10. [Frequently Asked Questions](#frequently-asked-questions)
11. [Getting Help](#getting-help)

---

## Getting Started

### Creating an Account

**For ASAP users:** You do not need to create an account. Simply sign in using the **ASAP Hub** tab (see below) — your account will be created automatically on first login.

**For non-ASAP users (DataSeer):**

1. Navigate to the KR-Sync login page
2. Select the **DataSeer** tab
3. Click "Don't have an account? Register"
4. Fill in your details:
   - Email address (this will be your username)
   - Full name
   - Password (must be at least 8 characters)
5. Click "Register"
6. You can now log in with your credentials

### Logging In

The login page offers two authentication methods, selectable via tabs:

#### ASAP Hub Login (for ASAP users)

1. Go to the KR-Sync login page
2. Select the **ASAP Hub** tab (selected by default)
3. Choose one of:
   - **Email and password:** Enter your ASAP Hub credentials and click "Sign in with ASAP"
   - **Google:** Click "Sign in with Google" and authenticate with your Google account
   - **ORCID:** Click "Sign in with ORCID" and authenticate with your ORCID credentials
4. You will be taken to your Dashboard
5. On your first login, an account is automatically created for you

#### DataSeer Login (for non-ASAP users)

1. Go to the KR-Sync login page
2. Select the **DataSeer** tab
3. Enter your email and password
4. Click "Sign In"
5. You will be taken to your Dashboard

### Dashboard Overview

After logging in, you'll see your Dashboard, which shows:

- **Recent Submissions**: Your most recent KRT submissions
- **Quick Actions**: Buttons to create new submissions or view all submissions
- **Statistics**: Overview of your submission status (drafts, in progress, completed)

---

## Understanding the Workflow

KR-Sync uses a 5-step workflow to process your Key Resource Tables:

```
Step 1            Step 2             Step 3        Step 4         Step 5
KRT Upload    →   PDF Analysis   →   Review    →   Availability   →   Report
Upload & Edit     Accept / Reject    View-only     View DAS           Excel
                  AI Suggestions                   suggestions
```

```mermaid
flowchart LR
    A["Step 1: KRT<br/>Upload & Edit"] --> B["Step 2: PDF<br/>Accept/Reject Suggestions"]
    B --> C["Step 3: Review<br/>View Changes (read-only)"]
    C --> D["Step 4: Availability<br/>View DAS suggestions"]
    D --> E["Step 5: Report<br/>Generate Excel"]

    A -.->|Back| Start(["Draft"])
    B -.->|Back| A
    C -.->|Back| B
    D -.->|Back| C
    E -.->|Back| D
    E --> F(["Completed"])
```

**Navigation:** You can move forward through the steps by completing each one, or go back to previous steps if you need to make changes.

**Step Overview:**

| Step | Name | What You Do | Editable? |
|------|------|-------------|-----------|
| 1 | KRT | Upload your KRT file, fix validation errors, edit data inline, add/delete rows | Yes |
| 2 | PDF | Upload manuscript PDF, let AI analyze it, **review and accept/reject/edit suggestions** | Yes — suggestion decisions live here |
| 3 | Review | See every change applied across the round (text + AI-driven), with full history and diffs | **No** — view-only |
| 4 | Availability | Review and edit the Data Availability Statement; the app checks it against the KRT contents and surfaces recommendations | Yes — the DAS is editable |
| 5 | Report | Generate the final Excel report, download and share | n/a — output step |

### What is a Key Resource Table (KRT)?

A Key Resource Table is a standardized document that lists all the key resources used in your scientific manuscript. Each row represents one resource and includes:

| Column | Description | Example |
|--------|-------------|---------|
| Resource Type | Category of the resource | Antibody, Cell Line, Dataset |
| Resource Name | Name of the resource | Anti-GFP Antibody |
| Source | Where the resource came from | Thermo Fisher |
| Identifier | Unique identifier | RRID:AB_123456 |
| New/Reuse | Is this new or reused? | New or Reuse |
| Additional Info | Any extra details | Dilution 1:1000 |

### Supported Resource Types

KR-Sync ships with 14 seeded resource types (the list is admin-editable from the Resource Types page):

1. Dataset
2. Code/Software
3. Protocol
4. Antibody
5. Bacterial strain
6. Biological sample
7. Chemical/peptide/protein
8. Critical commercial assay
9. Experimental model: Cell line
10. Experimental model: Organism/strain
11. Oligonucleotide
12. Recombinant DNA
13. Viral vector
14. Other

---

## Step 1: KRT Management

### Preparing Your KRT File

Before uploading, ensure your KRT file:

- Is in CSV (.csv) or Excel (.xlsx) format — legacy `.xls` and OpenDocument `.ods` files are not supported
- Has the correct column headers
- Contains at least one resource entry (or use the "Initialize an empty KRT" option below)

**Required columns:**
- Resource Type
- Resource Name
- New/Reuse (values: "new" or "reuse")

**Optional columns:**
- Source
- Identifier
- Additional Information

> **Tip:** A KRT template link is available on the upload page to help you get started.

### Uploading Your File

1. From the Dashboard, click "New Submission" or "Process New Document"
2. Enter a Title and Manuscript ID (Article ID)
3. Fill in the Data Availability Statement
4. Click "Upload KRT" or drag and drop your file
5. Wait for the file to be processed and validated

### Understanding Validation Results

After upload, KR-Sync automatically validates your KRT. You'll see indicators on:

- **Row number column**: Shows if the row has any issues (hover for summary)
- **Individual cells**: Shows specific cell errors/warnings (hover for details)

**Issue types:**

- **Errors** (Red): Should be fixed for best results
  - Example: "Missing required field: Resource Name"
  - Example: "Invalid resource type: Unknown"

- **Warnings** (Yellow): Should be reviewed
  - Example: "No identifier provided for row 5"
  - Example: "Possible duplicate entry detected"

### Editing Your KRT

You can edit your KRT directly in the application:

1. **Click on any cell** to edit its value
2. **Add new rows** using the form at the top
3. **Delete rows** using the trash icon on each row
4. **Quick N/A button**: For empty Identifier cells, click "N/A" to fill quickly
5. **Batch fixes**: When multiple rows have the same fixable issue, apply the fix to all at once

All changes are automatically saved and tracked with full history.

### Proceeding to Step 2

Once you've reviewed your KRT:
1. Check that critical errors are resolved
2. Click "Continue to PDF Analysis"

---

## Step 2: PDF Analysis

### What is PDF Analysis?

In this step, you upload your manuscript PDF. Our AI system will:

1. Read through your manuscript
2. Find references to resources mentioned in the text
3. Compare what's in your PDF with your KRT
4. Suggest additions, corrections, or deletions

### Uploading Your PDF

1. Click "Upload PDF" or drag and drop your manuscript
2. Supported formats: PDF only
3. Maximum file size: 50 MB
4. Wait for the upload to complete

### Watching the Analysis

1. Background analysis starts **automatically** when the PDF finishes uploading — there's no separate "Start Analysis" button
2. The Job Status panel shows every detection (DAS extraction, software, ORCID, materials, markdown conversion, datasets, protocols, identifier matching) plus the final PDF Analysis consolidator
3. Analysis typically takes 2-5 minutes total
4. You can leave and come back - your results will be waiting

If the Data Availability Statement could not be extracted automatically, the PDF Analysis step parks at "Needs input" — open the DAS card in step 4 to enter it manually, then come back to step 2 and click **Advance** to start the consolidator.

### Analysis Results

When analysis is complete, you'll see AI suggestions in a collapsible panel (expanded by default). The KRT editor below shows your data with suggestion indicators.

**Types of suggestions:**

1. **Add Row** (Blue + icon) - The AI found a resource in your PDF that's not in your KRT
   - Shows: Suggested resource data in a highlighted row
   - Action: Click Accept (checkmark) or Reject (X)

2. **Edit Cell** (Blue info icon on cell) - The AI suggests a correction to an existing value
   - Shows: Current value → Suggested value in tooltip
   - Action: Click the cell to open edit modal, then Accept or Reject

3. **Delete Row** (Red highlight) - The AI suggests removing a row
   - Shows: Row highlighted with delete suggestion
   - Action: Click Accept to delete or Reject to keep

**Visual indicators:**
- **Blue row number**: Row has AI suggestions
- **Blue cell icon**: Cell has an edit suggestion (hover for details)
- **Blue + row**: Suggested new row to add

Each suggestion shows:
- Title and description
- Confidence level
- Suggested data or changes

---

## Step 3: Final Review

### Understanding the Review Screen

The review screen shows your final KRT with all changes made throughout the process:

- **KRT Table**: Your complete Key Resource Table with change indicators
- **Change History**: Click the "?" icon on any cell to see its modification history
- **Data Highlighting**: Changed cells are highlighted to show what was modified

### Reviewing Change History

For each cell that was modified, you can:

1. **Hover over the cell** to see if it has history (look for the "?" icon)
2. **Click the "?" icon** to open the history modal showing:
   - Original value (from CSV upload)
   - Current value
   - Who made the change
   - When the change was made
   - Change source (manual, AI suggestion, or validation fix)

### Change Sources

Changes are tracked with their source:

| Source | Description |
|--------|-------------|
| Manual | You edited the cell directly |
| AI Suggestion | You accepted an AI recommendation |
| KRT Validation | You applied a validation fix |

### Making Final Edits

Before proceeding:
1. Review the complete KRT data
2. Check cells with history indicators
3. Make any final manual corrections if needed
4. Ensure all required fields are complete

### Proceeding to Step 4

Once you've completed your review:
1. Click "Continue" or "Approve"
2. You'll proceed to report generation

---

## Step 4: Edit the Availability Statement

This step focuses on the Data Availability Statement (DAS) that will be included in your manuscript.

### What You See

- The auto-extracted DAS (if the PDF Analysis step found one), with an **Edit** button to revise it
- A list of smart-rule recommendations that compare the DAS against the resources in your KRT — for example, flagging that your KRT contains new datasets but the DAS doesn't mention "data", or that no explicit "no new code" statement is present
- Each recommendation has a severity badge and a "Copy to clipboard" button with suggested text you can paste into your manuscript

### What to Do

1. Click **Edit** on the DAS card to refine the statement, then **Save**
2. Work through each applicable recommendation — outside of this app, update your manuscript's DAS so each one is addressed (or consciously decline a recommendation that doesn't apply)
3. Click **Continue** to proceed to report generation

The DAS lives on the submission record, so any future Excel report you generate uses the latest version.

---

## Step 5: Report Generation

### Available Report Types

1. **Excel Download** (active)
   - Downloads an `.xlsx` file with four sheets: Summary, KRT Data, Change History, and LM Analysis
   - The KRT Data sheet is sorted by resource-type group, then name
   - Best for attaching to compliance submissions or sharing offline

2. **Google Sheets** (coming soon — visible in the UI but currently disabled)

### Generating Your Report

1. Click **Download as XLSX**
2. Wait for generation (usually 10-30 seconds)
3. The new report appears in the "Generated Reports" list with a Download button

You can generate multiple reports — each reflects the current state of your KRT. Previous rounds are grouped in a "Previous Versions" accordion below.

### Report Contents

Your report includes multiple sections:

1. **Summary**
   - Manuscript ID and Title
   - Submission date and completion date
   - Total resources count
   - Number of changes made

2. **KRT Data**
   - Complete Key Resource Table
   - Final, validated data

3. **Change History**
   - All modifications made during the workflow
   - Change source (manual, AI, validation)
   - Timestamps and user info

4. **Analysis Summary** (if PDF analysis was run)
   - AI suggestions received
   - Acceptance/rejection status
   - Analysis metadata

### Completing the Submission

Generating your first report transitions the submission to **Completed** — there's no separate "Finish" button. From there you can keep generating additional reports or return to any previous step to make adjustments.

### Revising After Completion

Need to make changes after completing?
1. Open the completed submission from the Dashboard
2. Click **Process New Version** on step 5. The modal asks for two things:
   - **New PDF** (required) — pick the updated manuscript PDF (or DOCX). Uploaded immediately so the background analysis is already running by the time you land on the next step
   - **Do you have a new KRT file?** — *No* keeps your current KRT (carried forward to the new round); *Yes* starts you with a blank KRT to upload
3. You land on **step 2 (KRT)** for round N+1. The page shows your KRT (existing or blank) with the background processes already running on the new PDF.
4. If you need to swap the PDF again later in the same round, use the **Replace PDF** button on step 2 — it kicks off the analysis pipeline the same way.
5. Re-run the workflow and generate a new report (the "Previous Versions" accordion preserves earlier rounds)

---

## Managing Your Submissions

### Viewing All Submissions

From the Dashboard, click "View All Submissions" to see:

- All your submissions (or team submissions if you're a PM)
- Filter by status: Draft, In Progress, Completed
- Search by Manuscript ID
- Sort by date, status, or team

### Submission Statuses

| Status | Meaning |
|--------|---------|
| Draft | Just created, KRT not yet uploaded |
| Step 1: KRT | Working on KRT upload and validation |
| Step 2: PDF | Working on PDF upload and AI analysis |
| Step 3: Review | Reviewing changes before approval |
| Step 4: Availability | Reviewing and editing the Data Availability Statement |
| Step 5: Report | Generating final reports |
| Completed | First report generated; the submission can still be revised in a new round |

### Continuing a Submission

1. Find your submission in the list
2. Click on it to open
3. You'll be taken to where you left off
4. Continue the workflow from there

### Editing a Completed Submission

Need to make changes after completion?

1. Open the completed submission
2. Click **Process New Version** on step 5
3. Choose whether you have a new KRT file (the workflow lands you at step 1 or step 2 accordingly)
4. Re-run the workflow and generate a new report — earlier rounds are preserved in the "Previous Versions" list

---

## User Roles

### Author

As an Author, you can:
- Create new submissions
- Upload and edit your own KRTs
- Run PDF analysis on your submissions
- Generate reports for your submissions
- View your submission history

### ASAP PM (Project Manager)

As an ASAP PM, you can:
- View all submissions from your assigned team
- Edit submissions from your team
- Help team members with their KRTs
- Generate reports for team submissions

### DS Annotator (Data Science)

As a DS Annotator, you can:
- View and edit all submissions
- Assist any user with their KRTs
- Run analysis and generate reports
- Quality check submissions

### Admin

Administrators can:
- Manage user accounts
- Configure system settings
- Access all submissions
- View system statistics

---

## Frequently Asked Questions

### General Questions

**Q: What file formats can I upload for my KRT?**

A: KR-Sync accepts CSV (.csv) and Excel (.xlsx) files. Legacy `.xls` and OpenDocument `.ods` files are not supported.

**Q: How long does PDF analysis take?**

A: Typically 2-5 minutes, depending on the length of your manuscript. You can leave the page and come back - you'll see your results when you return.

**Q: Can I edit my KRT after uploading?**

A: Yes! You can edit your KRT at any point before generating the final report. All changes are tracked and can be undone.

### Upload Issues

**Q: My file won't upload. What should I do?**

A: Check that:
1. KRT files are under 10 MB and in `.csv` or `.xlsx` format
2. PDF / DOCX manuscripts are under 50 MB
3. Your internet connection is stable

Try refreshing the page and uploading again.

**Q: I'm getting validation errors. How do I fix them?**

A: Click on each error to see details. Common fixes:
- Missing Resource Name: Add names for all resources
- Invalid Resource Type: Use one of the 14 supported types
- Missing New/Reuse: Enter "new" or "reuse" for each row

### Analysis Questions

**Q: The AI suggested something incorrect. What should I do?**

A: Simply click "Reject" on that suggestion. The AI isn't perfect - your judgment is the final word.

**Q: Can I run analysis multiple times?**

A: Yes, you can upload a new PDF and run analysis again. Previous analysis results will be replaced.

**Q: What if the AI misses something in my PDF?**

A: You can always manually add rows to your KRT. The AI is a helper, not a replacement for your expertise.

### Report Questions

**Q: Can I generate multiple reports?**

A: Yes! You can generate as many Excel reports as you need. Each will reflect the current state of your KRT at the time you click Download.

**Q: How do I download my report?**

A: After generation, the report appears in the "Generated Reports" list — click the **Download** button to fetch the `.xlsx` file via a presigned link.

### Account Questions

**Q: What is the difference between ASAP Hub and DataSeer login?**

A: **ASAP Hub** is for users who belong to the ASAP organization — you can sign in with your Google account, ORCID, or ASAP Hub credentials. **DataSeer** is for non-ASAP users who registered directly on KR-Sync with an email and password.

**Q: I'm an ASAP user. Do I need to register?**

A: No. Just use the **ASAP Hub** tab to sign in. Your account will be created automatically the first time you log in.

**Q: How do I change my password?**

A: It depends on how you log in:
- **ASAP Hub users**: Your password is managed by your identity provider (Auth0). Change it through your ASAP Hub account settings. The KR-Sync profile page will show a message indicating this.
- **DataSeer users**: Go to your Profile page and use the "Change Password" form.

**Q: I forgot my password. What do I do?**

A: **ASAP Hub users**: Use the password reset on your identity provider (Google, ORCID, or ASAP Hub). **DataSeer users**: Contact your administrator to reset your password.

**Q: I used to log in with DataSeer but now I want to use ASAP Hub. What happens?**

A: If you sign in via ASAP Hub with the same email address, your existing account will be automatically linked. You keep all your submissions, role, and team assignments. You can then use either login method.

**Q: How do I change my team assignment?**

A: Contact your administrator to update your team assignment.

---

## Getting Help

### In-App Help

- Click the "?" icon in the top right corner for contextual help
- Hover over icons and buttons to see tooltips
- Look for blue information banners with helpful tips

### Reporting Issues

Found a bug or have a suggestion?

1. Click "Report Issue" in the app menu
2. Describe what happened
3. Include any error messages you saw
4. Submit - our team will investigate

---

## Quick Reference Card

### Keyboard Shortcuts (in the KRT editor)

| Shortcut | Action |
|----------|--------|
| Enter | Confirm cell edit |
| Escape | Cancel cell edit |
| Tab / Shift+Tab | Move to the next / previous editable cell |

All edits are saved automatically — there is no manual save shortcut.

### Status Colors

| Color | Meaning |
|-------|---------|
| Green | Success / Approved |
| Yellow | Warning / Needs attention |
| Red | Error / Rejected |
| Blue | Information |
| Gray | Pending / Not started |

### Workflow Summary

```
1. Create Submission
   └─> Enter Manuscript ID & Team

2. Upload KRT
   └─> Fix any validation errors
   └─> Edit data as needed

3. Upload PDF & Analyze
   └─> Wait for AI analysis
   └─> Review suggestions

4. Approve/Reject Changes
   └─> Review each suggestion
   └─> Make final edits

5. Generate Report
   └─> Choose format
   └─> Download or share
```

---

Thank you for using KR-Sync! We hope this guide helps you manage your Key Resource Tables efficiently.
