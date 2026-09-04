# Security Policy

This extension reads your Steam web session, creates and cancels real Steam trade offers on the
backend's instruction, and produces TLSNotary proofs of Steam state, so we take security seriously and
welcome reports.

## Reporting a vulnerability

**Please do not report security issues through public GitHub issues, pull requests, or discussions.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** (under *Advisories*).
3. Fill in the form with the details below.

This opens a private advisory visible only to you and the maintainers.

Please include, where possible:

- A description of the issue and its impact.
- The affected version (the `version_name` shown on the extension card, or a commit SHA).
- Steps to reproduce, or a proof of concept.
- Any suggested remediation.

We will acknowledge your report, keep you updated on our assessment, and coordinate a fix and
disclosure timeline with you. Please give us a reasonable opportunity to address the issue before any
public disclosure.

## Supported versions

Security fixes are made against the **latest released version** only; there are no back-ports.
Always upgrade to the newest release before reporting.

## Security model & scope

The extension is deliberately constrained. The following boundaries are enforced by design, and reports
demonstrating that any of them can be crossed are especially valuable:

- **The Steam credential is device-only.** It is read from the browser's cookie jar, used only against
  Steam, and never transmitted to the DMarket backend. The TLSNotary proof reveals the Steam response,
  never the request line that carries the token.
- **Only two Steam write actions exist: create and cancel a trade offer.** The extension never confirms
  or accepts trades, never handles Steam Guard or mobile-authenticator secrets, and never calls Steam
  mobile-confirmation endpoints. The user confirms trades themselves in the official Steam app.
- **The page bridge answers dmarket.com only**, validates message origin and shape, and never exposes
  credentials or device identifiers to the page.
- **Remote configuration cannot widen permissions.** Every remotely-tunable value is validated against
  the manifest's host permissions and compiled-in allow-lists; hosts, trust anchors and proof-read
  definitions are not remotely settable.
- **Error reports carry no account identity.** Crash reports are scrubbed of tokens, identifiers and
  query values before leaving the device, and reporting can be switched off in the popup.

Because this is open source, anyone can verify these properties in the source. Findings that show a gap
between these stated guarantees and the actual behavior are in scope and encouraged.
