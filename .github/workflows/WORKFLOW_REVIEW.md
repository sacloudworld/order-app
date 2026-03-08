# GitHub Actions Workflow Review — Order App CI/CD Pipeline

> **Scope:** `build.yml` · `deploy.yml`  
> **Reviewed:** March 8, 2026  
> **Standard reference:** GitHub Actions best practices, AWS Lambda deployment patterns, OWASP DevSecOps guidelines

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [build.yml — Detailed Review](#2-buildyml--detailed-review)
3. [deploy.yml — Detailed Review](#3-deployyml--detailed-review)
4. [Cross-Cutting Concerns](#4-cross-cutting-concerns)
5. [Priority Action Items](#5-priority-action-items)
6. [Industry Standard Reference Architecture](#6-industry-standard-reference-architecture)

---

## 1. Executive Summary

| Area | build.yml | deploy.yml | Verdict |
|---|---|---|---|
| Action versions | ⚠️ Outdated (v6 used) | ✅ Correct | Needs fix |
| Security / permissions | ❌ Missing | ❌ Missing | Critical gap |
| Concurrency control | ❌ Missing | ❌ Missing | Should add |
| Secrets handling | ✅ Using secrets | ✅ Using secrets | Good |
| Job sequencing | ✅ Correct chain | ✅ Gate condition | Good |
| Artefact management | ✅ Present | ⚠️ Partial | Needs fix |
| Deployment safety | N/A | ⚠️ No rollback | Needs fix |
| Observability | ⚠️ Basic only | ⚠️ No notifications | Should improve |
| Coverage enforcement | ✅ Via Jest threshold | N/A | Good |

**Overall rating: 6 / 10** — The pipeline has a solid structural foundation but is missing several industry-standard hardening practices that would be expected in a production-grade setup.

---

## 2. `build.yml` — Detailed Review

### 2.1 Action Version Pinning — 🔴 Critical

```yaml
# Current (incorrect)
uses: actions/checkout@v6
uses: actions/setup-node@v6
```

**Issue:** `actions/checkout@v6` and `actions/setup-node@v6` **do not exist**. The latest stable major versions are `@v4` for both. Using a non-existent tag causes the entire workflow to fail silently or use unexpected fallback behaviour depending on GitHub's resolution strategy.

**Industry standard:** Always pin to the latest **verified** major tag (e.g., `@v4`) or, for maximum supply-chain security, pin to the specific **commit SHA**:

```yaml
# Recommended — SHA pinning (highest security)
uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2
uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af  # v4.1.0
```

> **Why SHA pinning?** Protects against a compromised maintainer re-tagging `v4` to malicious code — a known supply-chain attack vector.

---

### 2.2 Missing `permissions` Block — 🔴 Critical

```yaml
# Current — no permissions declared; defaults to write-all
jobs:
  lint:
    runs-on: ubuntu-24.04
```

**Issue:** When `permissions` is not declared, the `GITHUB_TOKEN` defaults to `write` for most scopes. This violates the **principle of least privilege** and is flagged by tools like [StepSecurity Harden-Runner](https://github.com/step-security/harden-runner).

**Industry standard:** Declare the minimum required permissions at the workflow or job level:

```yaml
permissions:
  contents: read        # checkout
  actions: read         # download artifacts
  checks: write         # publish test results (if used)
```

---

### 2.3 Missing Concurrency Control — 🟠 High

**Issue:** Every push to `main` or a PR branch will queue a new run on top of any in-progress run. This wastes runner minutes and can lead to race conditions on artefact uploads.

**Industry standard:** Use `concurrency` to cancel stale runs:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

For the `deploy` workflow, set `cancel-in-progress: false` to avoid partial deployments.

---

### 2.4 Unnecessary Step in `lint` Job — 🟡 Medium

```yaml
# lint job only — not present in test/build jobs
- name: Configure Git identity
  run: |
    git config --global user.name "sacloudworld"
    git config --global user.email "sacloudworld@users.noreply.github.com"
```

**Issue:** A Git identity is **not required** for ESLint. This step adds ~1 second of noise and exposes the maintainer's GitHub username in plain text in a public file. This would only be needed if the workflow itself makes a commit (e.g., auto-formatting and pushing back).

**Recommendation:** Remove this step unless lint auto-commit is introduced. If auto-commit is added in future, use the dedicated GitHub Actions bot identity:

```yaml
git config --global user.name "github-actions[bot]"
git config --global user.email "github-actions[bot]@users.noreply.github.com"
```

---

### 2.5 `npm ci --omit=dev` Before `npm run build` — 🟠 High

```yaml
# build job
- name: Install dependencies
  run: npm ci --omit=dev

- name: Run build
  run: npm run build
```

**Issue:** The `build` script in `package.json` is:

```json
"build": "mkdir -p dist && cp -r src/* dist/"
```

This particular build script doesn't invoke any devDependency (e.g., Webpack, esbuild, tsc), so it works today. However, `--omit=dev` is a fragile assumption. If the build script ever calls a devDependency tool, the job will fail silently or with a cryptic error. Separating the intent ("install only prod deps") from the build step is also confusing to future maintainers.

**Recommendation:** Either:
- Run `npm ci` (full install) for the build step, then strip dev deps for packaging, **or**
- Add a comment explaining the deliberate omission

```yaml
# Install only production deps — build script is pure file copy, no devDep tools needed
run: npm ci --omit=dev
```

---

### 2.6 `dist/` Contains Test Files — 🟠 High

```yaml
- name: Run build
  run: npm run build  # cp -r src/* dist/
```

**Issue:** `src/index.test.js` is copied into `dist/` along with `index.js` because the build uses a blanket `cp -r src/* dist/`. This means **Jest test files ship inside the Lambda deployment package**, unnecessarily increasing bundle size and exposing internal test logic.

**Recommendation:** Exclude test files from the build copy, e.g.:

```bash
cp src/index.js dist/
# or use rsync with exclude
rsync -av --exclude='*.test.js' src/ dist/
```

---

### 2.7 No `timeout-minutes` on Jobs — 🟡 Medium

**Issue:** Without a timeout, a hung process (e.g., a network call inside a test, an npm script that never exits) will consume the full GitHub default of **6 hours** of runner time before being cancelled. This can exhaust your free minutes or incur unexpected costs.

**Industry standard:** Set conservative timeouts per job:

```yaml
jobs:
  lint:
    timeout-minutes: 10
  test:
    timeout-minutes: 15
  build:
    timeout-minutes: 15
  security-scan:
    timeout-minutes: 10
```

---

### 2.8 Use `npm run test:ci` Instead of `npm test` — 🟡 Medium

```yaml
# Current
- name: Run tests
  run: npm test
```

**Issue:** `package.json` already defines a dedicated CI test command:

```json
"test:ci": "jest --coverage --ci --forceExit"
```

The `--ci` flag disables interactive watch mode, enforces a clean snapshot state, and fails faster. The `--forceExit` flag ensures Jest doesn't hang waiting for open handles. These are critical for reliable CI runs.

**Recommendation:**

```yaml
- name: Run tests
  run: npm run test:ci
```

---

### 2.9 Security Scan Job Dependency — 🟡 Medium

```yaml
security-scan:
  needs: build
```

**Issue:** `npm audit` only requires that dependencies be installed — it does **not** depend on the build artefact. By chaining it after `build`, you add unnecessary wait time to the pipeline's critical path.

**Recommendation:** Run `security-scan` in parallel with `test` (both needing only `lint`), reducing total pipeline duration by the duration of the `build` job.

```yaml
security-scan:
  needs: lint   # can run in parallel with test
```

---

### 2.10 Missing SAST / Dependency Review — 🟡 Medium

**Issue:** `npm audit` only checks for known CVEs in direct/transitive dependencies. It does not:
- Scan source code for hardcoded secrets
- Check for insecure coding patterns
- Review newly introduced vulnerable deps on PRs

**Industry standard additions:**

| Tool | Purpose | Integration |
|---|---|---|
| `github/codeql-action` | SAST — source code vulnerability scanning | Add as separate job |
| `actions/dependency-review-action` | Blocks PRs that introduce vulnerable deps | Add to PR trigger |
| `trufflesecurity/trufflehog` or `gitleaks` | Secret scanning in commits | Add to push trigger |

---

### 2.11 Coverage Threshold is Moderate — 🟢 Informational

```json
"coverageThreshold": { "global": { "branches": 70, "functions": 70, "lines": 70 } }
```

A 70% threshold is the common minimum floor. For a Lambda handler with limited surface area, industry standard targets are **80–90%**. Consider raising this as the codebase matures.

---

### 2.12 No Test Result Publishing — 🟢 Informational

Only the raw coverage directory is uploaded as an artefact. Publishing structured test results using `dorny/test-reporter` or `EnricoMi/publish-unit-test-result-action` allows failed tests to be surfaced directly in the PR checks UI without downloading artefacts.

---

## 3. `deploy.yml` — Detailed Review

### 3.1 Artifact Download Breaks for `workflow_dispatch` — 🔴 Critical

```yaml
- name: Download Lambda artifact
  uses: actions/download-artifact@v4
  with:
    name: order-app-${{ github.event.workflow_run.head_sha || github.sha }}
    run-id: ${{ github.event.workflow_run.id }}   # ← EMPTY for workflow_dispatch
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

**Issue:** When triggered via `workflow_dispatch`, `github.event.workflow_run.id` is **empty/null**. The `actions/download-artifact@v4` action requires a valid `run-id` when downloading cross-workflow artefacts. This means the manual dispatch path is **broken**.

**Recommendation:** Either:
- Accept a `run-id` input parameter for `workflow_dispatch`, or
- Remove `workflow_dispatch` from deploy.yml and rely solely on the `workflow_run` trigger

```yaml
on:
  workflow_dispatch:
    inputs:
      run_id:
        description: 'Build workflow run ID to deploy'
        required: true
        type: string
```

---

### 3.2 No Rollback Mechanism — 🔴 Critical

**Issue:** If `aws lambda update-function-code` succeeds but the new code is broken (runtime error, bad config), there is no automated rollback. The pipeline simply reports success while production is degraded.

**Industry standard — AWS Lambda versioning + aliases:**

```bash
# Publish a new version after update
aws lambda publish-version --function-name $FUNCTION_NAME

# Update alias to point to new version
aws lambda update-alias \
  --function-name $FUNCTION_NAME \
  --name production \
  --function-version $NEW_VERSION

# On failure, revert alias to previous version
aws lambda update-alias \
  --function-name $FUNCTION_NAME \
  --name production \
  --function-version $PREVIOUS_VERSION
```

---

### 3.3 No Post-Deployment Smoke Test — 🟠 High

**Issue:** After deployment, only `LastModified` is checked — this confirms the file was **uploaded**, not that the function **runs correctly**. A broken package would show a `LastModified` timestamp but fail on invocation.

**Industry standard:**

```bash
RESPONSE=$(aws lambda invoke \
  --function-name $FUNCTION_NAME \
  --payload '{"queryStringParameters":{"name":"smoke-test"}}' \
  --cli-binary-format raw-in-base64-out \
  response.json)

STATUS=$(jq -r '.StatusCode' <<< "$RESPONSE")
if [ "$STATUS" != "200" ]; then
  echo "❌ Smoke test failed with status: $STATUS"
  exit 1
fi
echo "✅ Smoke test passed"
```

---

### 3.4 Missing `permissions` Block — 🔴 Critical

Same issue as `build.yml`. Additionally, the deploy workflow calls `actions/download-artifact@v4` with a `github-token`, which requires explicit `actions: read` permission.

```yaml
permissions:
  contents: read
  actions: read   # required for cross-workflow artifact download
```

---

### 3.5 No Deployment Notifications — 🟡 Medium

**Issue:** There is no notification on deployment success or failure. In an on-call production environment, teams need immediate visibility.

**Industry standard:** Add a notification step with `if: always()`:

```yaml
- name: Notify deployment status
  if: always()
  uses: slackapi/slack-github-action@v2
  with:
    payload: |
      {
        "text": "${{ job.status == 'success' && '✅' || '❌' }} Deploy *order-app* — ${{ job.status }}",
        "blocks": [...]
      }
  env:
    SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

---

### 3.6 AWS Region Hardcoded as Secret — 🟢 Informational

```yaml
aws-region: ${{ secrets.AWS_REGION }}
```

**Issue:** AWS region (`us-east-1`, etc.) is not sensitive information and shouldn't occupy a secret slot. Secrets are a limited resource in GitHub and should be reserved for credentials.

**Recommendation:** Promote to a repository variable or an environment variable:

```yaml
# In workflow env or environment variables (not secrets)
aws-region: ${{ vars.AWS_REGION }}
```

---

### 3.7 No Staging / Pre-Production Stage — 🟡 Medium

**Issue:** The pipeline deploys directly to `production` with no intermediate staging environment. This means every merged PR goes straight to production users.

**Industry standard — blue/green or staged deployment:**

```
main branch push
  → build
  → deploy to staging
  → run integration / smoke tests against staging
  → manual approval gate (GitHub environment protection rule)
  → deploy to production
```

Even for a small project, a staging Lambda alias costs nothing extra and provides a critical safety net.

---

### 3.8 Lambda Function Name Hardcoded as Secret — 🟢 Informational

Similar to `AWS_REGION`, the Lambda function name (`LAMBDA_FUNCTION_NAME`) is an identifier, not a credential. It can be promoted to `vars.LAMBDA_FUNCTION_NAME` to keep secrets minimal and improve auditability.

---

## 4. Cross-Cutting Concerns

### 4.1 No Environment File / `.env.example`

There is no documentation of the required secrets. A new contributor or DevOps engineer setting up this pipeline has no reference for which secrets must be configured in the GitHub repository or environment.

**Recommendation:** Create a `SECRETS.md` or document secrets in the repository README:

| Secret Name | Description | Scope |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | IAM access key for Lambda deployment | `production` environment |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key | `production` environment |
| `AWS_REGION` | AWS region (consider using `vars` instead) | `production` environment |
| `LAMBDA_FUNCTION_NAME` | Target Lambda function name | `production` environment |

---

### 4.2 No Dependabot / Renovate for Action Version Updates

**Issue:** Action versions (`actions/checkout`, `aws-actions/configure-aws-credentials`, etc.) will fall out of date silently. Outdated actions may contain security vulnerabilities.

**Recommendation:** Add `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
    labels:
      - "dependencies"
      - "github-actions"
```

---

### 4.3 IAM Least Privilege Not Verifiable

The pipeline uses `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (long-lived credentials). **Industry standard** for AWS + GitHub Actions is to use **OIDC (OpenID Connect)** federation, which eliminates long-lived AWS credentials entirely:

```yaml
permissions:
  id-token: write   # required for OIDC
  contents: read

- name: Configure AWS credentials (OIDC)
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/GitHubActionsDeployRole
    aws-region: ${{ vars.AWS_REGION }}
```

This is now the **recommended approach** by both GitHub and AWS, and is supported in all AWS regions.

---

### 4.4 No Branch Protection Rules Referenced

The `all-checks-pass` job in `build.yml` is designed to serve as a GitHub **required status check** for branch protection. However, this is only effective if the repository has branch protection rules configured on `main` that require this check to pass before merging. This should be documented.

---

## 5. Priority Action Items

### 🔴 Critical — Fix Immediately

| # | File | Issue | Risk |
|---|---|---|---|
| C1 | `build.yml` | `actions/checkout@v6` / `setup-node@v6` do not exist | Pipeline will fail |
| C2 | `build.yml` | Missing `permissions` block | Security vulnerability |
| C3 | `deploy.yml` | Missing `permissions` block | Security vulnerability |
| C4 | `deploy.yml` | `workflow_dispatch` artifact download is broken (`run-id` is null) | Manual deploy fails |
| C5 | `deploy.yml` | No rollback on bad deployment | Production outage risk |

### 🟠 High — Address Before Next Release

| # | File | Issue | Risk |
|---|---|---|---|
| H1 | `build.yml` | `npm test` should be `npm run test:ci` | Flaky/hanging CI runs |
| H2 | `build.yml` | Test files copied into Lambda package | Bloated artifact, test exposure |
| H3 | `build.yml` | `npm ci --omit=dev` before build is fragile assumption | Future build breakage |
| H4 | `deploy.yml` | No post-deployment smoke test | Silent broken deployments |
| H5 | Both | No concurrency control | Wasted runner minutes / race conditions |

### 🟡 Medium — Improve for Production Maturity

| # | File | Issue | Benefit |
|---|---|---|---|
| M1 | `build.yml` | Remove unnecessary Git identity from lint job | Cleaner, leaner job |
| M2 | `build.yml` | Add `timeout-minutes` to all jobs | Prevent runaway jobs |
| M3 | `build.yml` | Move `security-scan` to run in parallel with `test` | Faster pipeline |
| M4 | `build.yml` | Add CodeQL SAST scanning | Deeper vulnerability detection |
| M5 | `deploy.yml` | Add Slack/Teams deployment notification | Operational visibility |
| M6 | `deploy.yml` | Add staging environment before production | Deployment safety net |
| M7 | `deploy.yml` | Use `vars.AWS_REGION` instead of `secrets.AWS_REGION` | Better secrets hygiene |
| M8 | Both | Add Dependabot for action version updates | Stay current with security patches |

### 🟢 Informational — Consider for Long-Term

| # | File | Suggestion |
|---|---|---|
| I1 | Both | Migrate from IAM keys to OIDC federation | Eliminate long-lived credentials |
| I2 | `build.yml` | Raise coverage threshold from 70% to 80–90% | Higher quality gate |
| I3 | `build.yml` | Publish structured test results to PR UI | Better developer experience |
| I4 | Both | Pin actions to commit SHA instead of major tag | Maximum supply-chain security |
| I5 | Repo | Document required secrets in README or `SECRETS.md` | Faster onboarding |

---

## 6. Industry Standard Reference Architecture

The diagram below shows the target-state pipeline architecture based on the above recommendations:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        build.yml (CI)                               │
│                                                                     │
│  push / PR → main                                                   │
│                                                                     │
│  ┌─────────┐    ┌───────────────┬─────────────────┐    ┌────────┐  │
│  │  lint   │───▶│     test      │  security-scan   │───▶│ build  │  │
│  │ ESLint  │    │  Jest + cov   │  npm audit +     │    │ pkg +  │  │
│  │         │    │  --ci flag    │  CodeQL SAST     │    │ upload │  │
│  └─────────┘    └───────────────┴─────────────────┘    └────────┘  │
│                                          │                          │
│                              ┌───────────▼──────────┐              │
│                              │   all-checks-pass     │              │
│                              │   (branch protection) │              │
│                              └──────────────────────┘              │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                       deploy.yml (CD)                               │
│                                                                     │
│  workflow_run: build succeeded on main                              │
│                                                                     │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐ │
│  │ Deploy Staging  │───▶│ Smoke Test (stg)│───▶│ Manual Approval │ │
│  │ Lambda alias    │    │ Lambda invoke   │    │ (env protection)│ │
│  └─────────────────┘    └─────────────────┘    └────────┬────────┘ │
│                                                          │          │
│                              ┌───────────────────────────▼───────┐ │
│                              │       Deploy Production            │ │
│                              │  Lambda version + alias update     │ │
│                              └───────────────────────────────────┘ │
│                                          │                          │
│                   ┌──────────────────────▼─────────────────────┐   │
│                   │ Smoke Test (prod) → Rollback on failure     │   │
│                   │ Notify Slack on success / failure           │   │
│                   └────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Principles Applied

| Principle | Implementation |
|---|---|
| **Least Privilege** | Explicit `permissions` block + OIDC instead of IAM keys |
| **Fail Fast** | Lint first, security scan in parallel with tests |
| **Immutable Artefacts** | SHA-tagged Lambda artefact uploaded once, promoted across stages |
| **Safe Deployments** | Staging → approval → production, with Lambda versioning + rollback |
| **Supply Chain Security** | SHA-pinned actions + Dependabot + CodeQL |
| **Observability** | Test result publishing + deployment notifications |
| **Concurrency Safety** | `concurrency` block with `cancel-in-progress: true` on CI |
