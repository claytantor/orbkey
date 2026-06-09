# 01 — Prerequisites

You need these once, on the machine you deploy from. Note the split:

- The **orbkey CLI** is TypeScript / Node.js (AWS SDK v3).
- The **CDK infrastructure app** is Python aws-cdk-lib v2 (infra-as-code only).

You can run both from the same machine, or deploy from one machine and run the
CLI from another — only the CLI machine needs the AWS *app* credentials.

## Accounts & tools

- **An AWS account** you control, and AWS CLI configured for the *deploy*
  principal (an admin/role that may create KMS keys, S3 buckets, and IAM users):
  ```bash
  aws configure          # or: aws configure sso
  aws sts get-caller-identity   # confirm you're the deploy principal
  ```
- **Node.js 18+** — for the orbkey CLI and the CDK CLI:
  ```bash
  node --version         # 18+ (20+ recommended)
  npm --version
  ```
- **AWS CDK CLI** (required even though the stack is written in Python):
  ```bash
  npm install -g aws-cdk
  cdk --version          # 2.x; must be >= the aws-cdk-lib used in cdk/pyproject.toml
  ```
- **Python 3.11+** — required by the CDK app (`cdk/pyproject.toml` →
  `requires-python = ">=3.11"`):
  ```bash
  python3 --version      # must be >= 3.11
  ```
  A virtualenv tool is recommended (`uv`, or stdlib `venv`):
  ```bash
  curl -LsSf https://astral.sh/uv/install.sh | sh   # optional but convenient
  ```

> The orbkey CLI bundles `better-sqlite3`, so there is **no** separate SQLite /
> FTS5 system dependency to install for the app — it ships with the npm package.
> (FTS5 is compiled into `better-sqlite3`.)

## Keep the CDK CLI and library in sync

aws-cdk-lib (in `cdk/pyproject.toml`) emits a cloud-assembly schema version that
the `cdk` CLI must be new enough to read. If `cdk synth` complains about a
**schema version mismatch**, upgrade the CLI:

```bash
npm install -g aws-cdk@latest
# or pin the library down in cdk/pyproject.toml to match an older CLI
```

You can always run a matching CLI ad hoc without a global install:

```bash
npx --yes aws-cdk@latest synth
```

## Bootstrap CDK (once per account/region)

```bash
cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
```

`<ACCOUNT_ID>` and `<REGION>` come from your deploy principal
(`aws sts get-caller-identity` / your configured region). Add `--profile <name>`
if you use named profiles.

Next: [02-deploy-infrastructure.md](02-deploy-infrastructure.md).
