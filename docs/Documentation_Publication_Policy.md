# Documentation publication policy

This repository is public. Anything pushed to any branch, and any pull request or issue text, can be read by anyone and may be copied before it is changed. Editing a file or a description later does not remove the earlier version from history.

## What must not be published

| Category | Write instead |
| --- | --- |
| Customer, studio or legal business names, their web addresses and slugs | `the pilot studio`, `[STUDIO-NAME]`, `[LEGAL-NAME]` |
| Studio, user, tenant or record identifiers from a real environment | `[STUDIO-ID]`, `[USER-ID]` |
| Personal names, email addresses and phone numbers | `[CONTACT]`, `person@example.test`, a `555-01xx` number |
| Provider account, profile, customer or support-case identifiers | `[PROVIDER-ACCOUNT-ID]`, `[PROVIDER-TICKET]` |
| Tax identification numbers, even partly | `00-0000000` |
| Terms agreed for one customer or pilot: caps, allowances, reserves, negotiated prices, approval references | `[PILOT-CAP]`, `[PILOT-ALLOWANCE]` |
| Plans for unreleased products, internal spending controls and day-to-day operating records | keep them in the private record and link to nothing |

These rules cover documentation, scripts kept as documentation, file names, branch names, commit messages and pull request text. Keep the real values in a private record outside the repository. A document that needs them says that it is a template.

Do not edit database migration files to apply this policy: files that have been applied must stay byte for byte as they are. Keep real values out of new ones.

## The automated check

`scripts/docs-publication/check.mjs` runs on every pull request and fails when a changed documentation file (`docs/**` or any Markdown file) adds:

- a UUID, other than a placeholder made of repeated digits;
- a provider SID or provider object identifier;
- an email address, other than a reserved example domain or an entry in `allowlist.json`;
- a phone number, other than a reserved `555` number;
- a value shaped like an employer identification number;
- a name on the private list, in the text or in the file name.

It reads the lines a pull request adds. A moved or renamed file counts as new and is read whole. It does not print what it matched, only the file, line and kind.

Run it before the first push, because a pushed branch is already public:

```sh
node scripts/docs-publication/check.mjs --base origin/main
```

Audit the whole tree with `--all`. Existing documents contain older values, so the audit is expected to report findings until they are cleaned up.

### Private name list

Names are never committed. The check reads them from the environment variable `DOCS_PUBLICATION_DENYLIST`, one per line or separated by `;`. Matching ignores case, spacing and punctuation, so one entry also covers its slug and file-name forms. Terms shorter than four letters or digits are ignored. In CI the variable comes from a repository Actions secret of the same name. While it is not set, and on pull requests from forks, the check says that names were not checked.

### Limits

The check finds shapes and listed names. It cannot judge commercial terms, plans or an unlisted name, it does not read pull request text, images or application code, and it runs after a push. Review remains necessary.

### Allowlist

`allowlist.json` holds exact public values only, such as published role mailboxes. A change to it is reviewed like a change to the check.

## Proposed repository settings (not applied)

Each item needs the owner's decision.

1. Add to `.github/CODEOWNERS`:

   ```text
   /scripts/docs-publication/ @genxttech
   /docs/Documentation_Publication_Policy.md @genxttech
   ```

2. Add `Documentation publication check` to the required status checks of the rulesets for `main` and `release/**`, after the workflow exists on each of those branches.
3. Create the Actions secret `DOCS_PUBLICATION_DENYLIST`.
4. Bring the check to the release branch so that pull requests into it are covered.
