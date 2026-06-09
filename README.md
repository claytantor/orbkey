# orbkey

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)

**An AWS-backed, local-first secrets vault that lives in your terminal.**

orbkey keeps your secrets encrypted on your own machine, syncs them through an
S3 bucket and KMS key **in your own AWS account**, and gives you a fast,
keyboard-driven terminal UI to manage them. No third-party SaaS, no server to
run, no plaintext ever written to disk or logged.

This is the TypeScript + [Ink] rewrite of the original Python/Textual orbkey. It
is **byte-compatible** with vaults the Python version created (Argon2id KDF,
AES-256-GCM blob framing, KMS envelope, serialized SQLite image, and the
`keychain.json` / `config.json` / `state.json` file shapes), so you can move
between implementations against the same vault.

---

## Why orbkey?

| | orbkey | Cloud password managers | Plaintext `.env` / dotfiles |
| --- | --- | --- | --- |
| **Where secrets live** | Your machine + your AWS account | A vendor's servers | Scattered, in the clear |
| **Who holds the keys** | You (KMS key in your account) | The vendor | Nobody — they're plaintext |
| **Works offline** | Yes (sync is explicit) | Partially | Yes, dangerously |
| **Audit trail** | CloudTrail on your KMS/S3 | Vendor dashboard | None |
| **Cost** | Cents/month of S3 + KMS | Subscription | Free, until it leaks |

**Local-first.** The vault is an encrypted SQLite image held in memory while
unlocked. You read and write at local speed; sync to S3 happens only when you
ask (or on a clean exit).

**Your keys, your account.** Encryption is a KMS envelope using a customer
master key *you* own. orbkey never sees a key it didn't derive from your
password or fetch from your KMS. Revoke access by revoking the IAM user — the
ciphertext is useless without your CMK.

**Built for the terminal.** Live fuzzy filter, copy-over-display (the secret
goes to your clipboard, not your scrollback), masked values by default,
auto-clearing clipboard, and idle auto-lock.

---

## Getting started

### One-line install

```sh
curl -fsSL https://raw.githubusercontent.com/claytantor/orbkey-ts/main/install.sh | bash
```

> Don't pipe scripts you haven't read. The installer just runs the manual steps
> below — clone, `npm ci`, `npm run build`, then `npm link` so the `orbkey`
> command is on your `PATH`. Read it first if you like.

### Manual install (recommended if you cloned the repo)

```sh
git clone https://github.com/claytantor/orbkey-ts.git
cd orbkey-ts
npm ci            # install dependencies
npm run build     # compile TypeScript -> dist/
npm link          # put the `orbkey` binary on your PATH
```

Requirements: **Node.js ≥ 20** and a real terminal (TTY). On Linux you'll also
want a clipboard backend for copy-to-clipboard — `wl-clipboard` (Wayland) or
`xclip` (X11). orbkey falls back to OSC52 over the terminal if neither is
present.

### Run it

```sh
orbkey            # the installed binary
# or, from a checkout without installing:
npm run dev       # tsx src/index.ts (no build step)
node dist/index.js
```

The first time you launch with no vault configured, orbkey walks you through a
**first-run** screen to point at your AWS backend and set your vault password.
That backend is created with the supplied CDK stack — see
[Set up your AWS vault backend](#set-up-your-aws-vault-backend).

If you already have a vault (e.g. created by the Python orbkey), launch lands on
the **Unlock** screen — type your password and you're in. orbkey reads its
config from `$XDG_CONFIG_HOME/orbkey` (default `~/.config/orbkey`).

---

## Set up your AWS vault backend

orbkey stores its synced vault in **your** AWS account: one S3 bucket (versioned,
TLS-only, private) holding a single encrypted object, and one KMS customer
master key (with rotation enabled) that wraps the data key. A scoped IAM user
gets least-privilege access to exactly those two resources.

A ready-to-deploy AWS CDK project ships in [`devops/`](devops/). The short
version:

```sh
cd devops/cdk
python -m venv .venv && source .venv/bin/activate
pip install -e .

# one-time per account/region
npx aws-cdk@latest bootstrap aws://<ACCOUNT_ID>/<REGION>

# review what will be created, then deploy
npx aws-cdk@latest synth
npx aws-cdk@latest deploy
```

When the stack finishes it prints CloudFormation **outputs**. Translate them
into `~/.config/orbkey/config.json` (orbkey reads this exact snake_case shape):

| CDK output | `config.json` field |
| --- | --- |
| `bucket_name` | `bucket` |
| `kms_key_arn` | `kms_key_id` |
| `vault_object_key` | `object_key` (default `vaults/default/vault.bin`) |

```json
{
  "bucket": "orbkey-vault-123456789012-us-east-1",
  "kms_key_id": "arn:aws:kms:us-east-1:123456789012:key/abcd-...",
  "object_key": "vaults/default/vault.bin"
}
```

The full walkthrough — prerequisites, deploy, first run, day-2 operations
(key rotation, S3 versioning, destroy), and troubleshooting — lives in
[`devops/cookbooks/`](devops/cookbooks/) and [`devops/README.md`](devops/README.md).
Those docs also cover the exact least-privilege IAM the tool needs
(`s3:GetObject`/`PutObject` with conditional-write headers, `kms:Encrypt`/
`Decrypt`/`GenerateDataKey`/`DescribeKey`, `sts:GetCallerIdentity`).

> **Cost & safety.** The backend is essentially free at personal scale (a few
> cents of S3 + KMS per month). The stack enables KMS key rotation, S3
> versioning, and denies non-TLS access. You can tear it all down with
> `npx aws-cdk@latest destroy`.

---

## Architecture

```
src/
  models.ts            domain types (Secret, Label, VaultSnapshot)
  core/                headless, UI-agnostic engine (the bulk of the value)
    crypto.ts          Argon2id + AES-256-GCM + KMS envelope (Python-compatible framing)
    keychain.ts        password-encrypted DB key + IAM creds
    store.ts           in-memory SQLite vault + FTS5 search (better-sqlite3)
    sync.ts            S3/KMS sync engine + launch state machine
    config.ts          XDG paths, DeviceState, atomic writes
    aws.ts             AWS SDK v3 clients + credential validation
    session.ts         Session orchestrator — the ONLY surface the UI calls
    keepass.ts         KeePass 2.x XML import
  sessionAdapter.ts    bridges core Session -> UI SessionPort (the one core<->UI seam)
  clipboard.ts         clipboardy + OSC52 with auto-clear
  ui/                  Ink front-end — depends ONLY on SessionPort (no core / @aws-sdk)
    app.tsx            providers + modal router + global keys + idle auto-lock
    commands.ts        slash-command runner (the test seam)
    state.ts           pure reducer + screen state machine
    components/        VaultHeader, SecretList, DetailPane, StatusLine, CommandBar, ...
    screens/           Unlock, FirstRun, AddEdit, Confirm, Conflict, Help, Import, Rotate
  index.ts             CLI entry (renders <App/>; degrades on non-TTY)

devops/                AWS CDK stack + cookbooks to provision the vault backend
```

**Three clean layers.**

1. **Core engine** (`src/core/`) is headless and UI-agnostic. It does the
   cryptography, the SQLite vault, the AWS I/O, and the sync state machine.
   `Session` is the *only* class the rest of the app may touch.
2. **The seam.** The UI never imports core or `@aws-sdk/*`. It talks to a
   narrow `SessionPort` interface; `sessionAdapter.ts` is the single bridge
   between core and UI. This boundary is enforced and tested.
3. **The Ink UI** (`src/ui/`) is a pure `useReducer` app: a pure reducer drives
   a screen state machine, every mutation bumps a `storeVersion` so the view
   never goes stale, and a "swap-don't-stack" modal router shows one screen at a
   time. The layout is adaptive to terminal width and height.

**Security properties baked in.** Secret values are masked by default,
copy-over-display is preferred (the value goes to the clipboard, never the
screen or the logs), the clipboard auto-clears, destructive actions confirm,
and idle sessions auto-lock and zeroize keys.

**How sync stays consistent.** The vault object is written with S3 conditional
writes (`If-Match` / `If-None-Match` on the ETag) — optimistic concurrency. If
another device pushed since you last pulled, you get a **conflict** screen
rather than a silent overwrite.

```sh
npm install        # dependencies
npm run dev        # tsx src/index.ts (interactive TTY required)
npm test           # vitest: core + parity + UI suites
npm run build      # tsc -> dist/
npm run typecheck  # tsc --noEmit
```

---

## Using the TUI

orbkey is keyboard-first. On the **home** screen you have a list of secrets on
the left and a detail pane on the right, a single-line status bar at the bottom
showing the current mode and selection, and a command bar.

- **Filter live** by just typing — the list narrows as you go.
- **Move** the selection with the arrow keys.
- **Run a command** by typing `/` followed by a command (e.g. `/add`), or use
  the keyboard shortcuts below.
- **Reveal** the selected secret's value with `Ctrl+R` (it hides again on the
  next `Ctrl+R`, on lock, or on idle).
- Most commands act on the **selected** secret, or on a named one if you pass an
  argument: `/get github-token`.

### Cheat sheet

**Global keys**

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move selection in the list |
| *(type)* | Live-filter the list |
| `Ctrl+R` | Reveal / hide the selected value |
| `Esc` | Close the current modal / screen |
| `Ctrl+Q` | Exit (final checkpoint + sync if dirty) |
| `/` then text | Run a slash command |

**In the add/edit modal**

| Key | Action |
| --- | --- |
| `Tab` | Next field |
| `Ctrl+O` | Copy the note to the clipboard |
| `Ctrl+P` | Paste into the note |
| `Esc` | Cancel |

**Slash commands**

| Command | What it does |
| --- | --- |
| `/add` | Add a secret (key, value, labels, note) |
| `/get [key]` | Reveal the selected/named secret **and copy it to the clipboard** |
| `/edit [key]` | Edit the selected/named secret |
| `/label` | Edit labels on the selected secret |
| `/note` | Edit the note on the selected secret |
| `/rm [key]` (or `/delete`) | Delete the selected/named secret (confirms first) |
| `/search <term>` | FTS5 full-text search (same as typing to filter) |
| `/import [path]` | Import secrets from a KeePass 2.x XML export |
| `/sync` | Push/pull now (runs the sync state machine) |
| `/rotate` | Rotate the vault password or the cached IAM key |
| `/lock` | Zeroize keys and require the password again |
| `/clipinfo` | Report which clipboard backends are available |
| `/help` | Show the in-app command reference |
| `/exit` | Final checkpoint, sync if dirty, then quit |

> **Copy needs a clipboard backend.** On Wayland install `wl-clipboard`; on X11
> install `xclip`. Without one, orbkey uses OSC52 (works in many terminals over
> SSH too).

### Configuration

Environment variables tune runtime behavior:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORBKEY_AUTOLOCK_MIN` | `15` | Idle minutes before the vault auto-locks |
| `ORBKEY_CLIP_CLEAR_SEC` | `30` | Seconds before the clipboard auto-clears after a copy |
| `XDG_CONFIG_HOME` | `~/.config` | Base dir for `orbkey/` config + checkpoints |

orbkey keeps three files under `$XDG_CONFIG_HOME/orbkey`:

- `keychain.json` — your password-encrypted DB key + IAM credentials
- `config.json` — the (non-secret) vault locators: bucket, KMS key, object key
- `state.json` — per-device sync bookkeeping (never synced into the vault)

…plus encrypted local checkpoints under `checkpoints/`.

---

## Development

```sh
npm install
npm run dev        # run from source with tsx
npm test           # full vitest suite (core, parity, UI)
npm run typecheck  # tsc --noEmit, strict
npm run lint       # eslint
npm run build      # tsc -> dist/
```

The test suite includes a **parity** layer that loads fixtures produced by the
Python orbkey and asserts the TypeScript implementation reads/writes them
byte-for-byte — that's what guarantees cross-implementation vault
compatibility.

---

## License

[MIT](LICENSE) © claytantor

[Ink]: https://github.com/vadimdemedes/ink
