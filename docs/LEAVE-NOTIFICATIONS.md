# Leave requests and notifications

The authenticated application exposes Concedii and Notificări for agents and managers. Each agent has an employee profile linked to their existing account; warehouse names and display names are not used as employee identifiers.

## Employee setup and calendar

Managers confirm the legal name, employer, all currently assigned approvers and their email addresses in Concedii → Profiluri angajați. The global manager configures the HR destination separately. Missing or changed assignments require confirmation rather than silently choosing a recipient. Company data and addresses belong in private configuration, never in source fixtures.

Periods use date-only inclusive bounds and Monday–Friday working days. Romanian fixed holidays, Orthodox or Western Easter/Good Friday/Pentecost, and additional employee holidays are excluded. The server calculates the authoritative total and stores the selected dates and excluded dates with the request. The calendar rules are versioned in source and need maintenance when legislation changes. Annual balances are not inferred from the new request history and are not displayed until an authoritative balance is configured.

## Request lifecycle

Agents create and revise their own drafts. They can draw a fresh signature on a touch device, or print the unsigned PDF and upload a JPEG/PNG photograph of the signed paper. Image uploads are bounded, validated and converted to PDF. A submitted request contains an immutable PDF and identity/calendar/recipient snapshot. Draft changes clear signatures. Concurrent or overlapping active submissions are rejected atomically.

All assigned managers receive an in-app notification. Either assigned approver can approve or reject; a global manager can administer decisions. The first version-matched decision wins. Rejection and cancellation require a reason. Agents can cancel their drafts and pending requests; an approved request requires a manager cancellation. Events preserve the actor, time and reason. Removed managers lose access through the current team scope.

The drawn signature is a document image, not a qualified electronic signature. Internal acceptance of this signing method remains an employer policy. Manager approval is an audited application decision; the application does not draw or impersonate a manager signature.

## Email on tablets

After submission, the agent downloads the named signed PDF and opens a mailto link with To, all manager CC recipients, subject and body populated. The agent manually attaches that PDF in the tablet mail application and sends it. Draft PDFs have a distinct download filename. The application does not claim that opening a mail link sends a message or attaches a file, and it does not record externally sent mail as verified delivery. Native mail applications remain responsible for their own handling of mailto parameters.

## Notification engine

The bell offers a compact inbox and the full page offers categories, unread filtering, pagination and read controls. Persistent notifications are recipient-owned and deduplicated by recipient/event key. Domain events and notification rows are committed in the same transaction. Leave push alerts contain generic lock-screen text; push is optional per device and the inbox works without push permission. Existing partner notifications and their per-manager read state remain available.

Activation and order categories are reserved for future event producers. This release does not evaluate activation ratios, emit historical activation alerts, or enable order business rules. New producers should define a stable event key, recipient authorization, grouping and a transition-based rule before publishing events. Re-importing the same source must not create repeated notifications.

## Validation

The suite covers calendar boundaries and three-year intervals, PDF text/diacritics and page layout, image limits and EXIF rotation, profile/membership changes, concurrent decisions, overlapping leave, document immutability, recipient isolation, legacy notification state, account switches, and portrait/landscape tablet layouts. Browser mail tests verify the generated link and download; they do not send messages.
