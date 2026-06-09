# orbkey — DevOps / Infrastructure

This directory provisions the AWS backend that the **orbkey** TUI (TypeScript /
Ink, AWS SDK v3) syncs against, and documents the deploy → configure → first-run
flow.

orbkey is **local-first**: your vault lives encrypted on disk and is mirrored to
a single S3 object. The app performs **KMS envelope encryption** locally (the
S3 payload is already AES-256-GCM ciphertext, wrapped with a KMS data key), so
the infrastructure is deliberately minimal.

```
devops/
  architecture.puml         component diagram of the stack
  cdk/                      aws-cdk-lib v2 app (Python — infra-as-code)
    app.py                  CDK app entry
    orbkey_stack.py         the stack (KMS CMK, S3 bucket, IAM user + key)
    cdk.json                CDK config
    pyproject.toml          Python project metadata
  cookbooks/
    01-prerequisites.md     tools you need once on the deploy machine
    02-deploy-infrastructure.md
    03-first-run.md         translate stack outputs -> ~/.config/orbkey
    04-operations.md        rotation, versioning recovery, conflicts, teardown
    05-troubleshooting.md
```

> The CDK app is **Python aws-cdk-lib v2**. That is intentional and independent
> of the app being TypeScript — the infrastructure is plain infra-as-code. Do
> not rewrite it to TS-CDK.

## What gets created in your AWS account

| Resource | CDK id | Notes |
|---|---|---|
| KMS symmetric CMK | `OrbkeyKey` | `alias/orbkey-default`, **annual key rotation on**, `RETAIN` on stack delete |
| S3 bucket | `OrbkeyBucket` | **versioned**, SSE-S3, TLS-only (deny non-SSL), all public access blocked, `RETAIN` |
| IAM user | `OrbkeyUser` | least-privilege; see below |
| IAM access key | `OrbkeyAccessKey` | long-lived key for the user; surfaced in stack outputs |

### Exact IAM permissions (and why)

The policy grants **only** what the SDK-v3 client in `src/core/aws.ts` and the
sync engine in `src/core/sync.ts` actually call:

| Action | Resource scope | Used by |
|---|---|---|
| `kms:GenerateDataKey` | the CMK only | envelope encryption on every push (`crypto.kmsEncrypt`) |
| `kms:Decrypt` | the CMK only | envelope decryption on every pull (`crypto.kmsDecrypt`) |
| `kms:DescribeKey` | the CMK only | first-run / unlock credential validation (`validateCreds`) |
| `s3:ListBucket` | bucket, prefix `vaults/default/*` | first-run validation (`ListObjectsV2`) |
| `s3:GetObject` | `vaults/default/*` | HEAD + GET of the vault object (HEAD is authorized by GetObject) |
| `s3:PutObject` | `vaults/default/*` | push, **including `If-Match` / `If-None-Match` conditional writes** |
| `sts:GetCallerIdentity` | — | account-id check; allowed for every principal, no grant needed |

The optimistic-concurrency model (`src/core/sync.ts`) relies on conditional
PutObject:

- **First write** uses `If-None-Match: *` — succeeds only if the object does not
  yet exist (create-if-absent).
- **Subsequent writes** use `If-Match: <etag>` — succeeds only if the remote
  ETag still matches what this device last synced; otherwise S3 returns **412**
  and orbkey raises a conflict.

These conditional headers do **not** require a distinct IAM action — they are
authorized under `s3:PutObject`. Likewise a HEAD request is authorized under
`s3:GetObject`. The policy above is therefore both sufficient and minimal.

> **Reconciliation note:** the original (Python-era) stack granted only
> `kms:Decrypt` + `kms:GenerateDataKey`. The TS client additionally calls
> `kms:DescribeKey` during credential validation, so first run would have failed
> with AccessDenied. This stack adds `kms:DescribeKey` (CMK-scoped). It also
> tightens `s3:ListBucket` with an `s3:prefix` condition. See
> [cookbooks/05-troubleshooting.md](cookbooks/05-troubleshooting.md).

## Cost

Pennies/month for a single-user vault:

- **KMS CMK:** ~$1.00/mo for the key + per-request charges (a handful of
  `GenerateDataKey`/`Decrypt` calls per session). This is the only non-trivial
  line item.
- **S3:** a single small object plus old versions — effectively free at this
  scale; you pay tiny request + storage costs.
- **IAM / STS:** free.
- **Secrets Manager** (optional secret delivery, see cookbook 02): ~$0.40/mo if
  you enable it.

## Security model

- The S3 payload is **double-unreadable** without the CMK *and* your password:
  it is AES-256-GCM plaintext wrapped by a KMS data key, then the bucket adds
  SSE-S3 at rest.
- The IAM user is **scoped to one prefix and one key**. It cannot read other
  buckets, other KMS keys, or manage IAM.
- The **secret access key appears in CloudFormation outputs** for a single-user
  self-hosted tool this is an accepted tradeoff. Retrieve it once, paste it into
  first run, and consider rotating (cookbook 02 / 04). To avoid it entirely, use
  the Secrets Manager option.
- Bucket and CMK are `RETAIN`: `cdk destroy` will **not** delete your vault or
  key.

## The flow (deploy → configure → first run)

1. **Prerequisites** — Node.js, AWS CDK CLI, Python 3.11+ for the CDK app, an
   AWS deploy principal. See [01-prerequisites.md](cookbooks/01-prerequisites.md).
2. **Deploy** — `cdk bootstrap` (once), then `cdk deploy`; capture the outputs.
   See [02-deploy-infrastructure.md](cookbooks/02-deploy-infrastructure.md).
3. **First run** — install/launch the orbkey CLI, paste the outputs into the
   first-run form (which writes `~/.config/orbkey/config.json` +
   `keychain.json`), set a password.
   See [03-first-run.md](cookbooks/03-first-run.md).

## What you must supply to deploy

The CDK app uses `cdk.Environment()` with no hardcoded account/region, so it
reads from your AWS CLI environment:

- **AWS account id** and **region** — from your active profile (`aws configure`)
  or `AWS_PROFILE` / `AWS_REGION` / `CDK_DEFAULT_*`.
- **A deploy principal** with rights to create KMS keys, S3 buckets, and IAM
  users/keys (typically an admin role — distinct from the scoped `OrbkeyUser`
  the stack creates for the app).
- Optionally `--profile <name>` on `cdk` commands to pick a non-default profile.

## Validating locally

`cdk synth` runs without AWS credentials and only renders the CloudFormation
template. This tree has been validated with `cdk synth` (KMS Decrypt/
GenerateDataKey/DescribeKey, S3 Get/Put/ListBucket with the `s3:prefix`
condition, key rotation, versioning, and the non-SSL deny all present in the
template). Do **not** run `cdk deploy` / `cdk bootstrap` unless you intend to
create real, billable resources.
