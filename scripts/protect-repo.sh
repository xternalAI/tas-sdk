#!/usr/bin/env bash
# Applies the repository protections this project relies on once it is open source. Run it once,
# as an admin, right after making the repository public: GitHub's free plan refuses every one of
# these settings on a private repository. Safe to run again; it updates what is already there.
#
#   scripts/protect-repo.sh [owner/repo]
#
# What it sets:
#   1. Workflows on pull requests from outside contributors wait for a maintainer's approval.
#   2. The "npm" environment, which the release job runs in, needs the caller's approval per run
#      and only accepts runs from main.
#   3. main: changes arrive by pull request with CI green; no force pushes, no deletion.
#   4. Version tags (v*) cannot be moved or deleted once created.
set -euo pipefail

repo="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
reviewer="$(gh api user -q .id)"
echo "Protecting ${repo}; releases will need approval from $(gh api user -q .login)."

# Create a ruleset, or replace the one with the same name.
ruleset() {
  local name="$1" body="$2" id
  id="$(gh api "repos/${repo}/rulesets" -q ".[] | select(.name == \"${name}\") | .id")"
  if [ -n "${id}" ]; then
    gh api -X PUT "repos/${repo}/rulesets/${id}" --input - <<<"${body}" >/dev/null
  else
    gh api -X POST "repos/${repo}/rulesets" --input - <<<"${body}" >/dev/null
  fi
  echo "  ruleset: ${name}"
}

echo "1. Approval for outside contributors' workflow runs"
gh api -X PUT "repos/${repo}/actions/permissions/fork-pr-contributor-approval" -f approval_policy=all_external_contributors >/dev/null

echo "2. The npm environment"
gh api -X PUT "repos/${repo}/environments/npm" --input - >/dev/null <<JSON
{
  "reviewers": [{ "type": "User", "id": ${reviewer} }],
  "prevent_self_review": false,
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
JSON
if ! gh api "repos/${repo}/environments/npm/deployment-branch-policies" -q '.branch_policies[].name' | grep -qx main; then
  gh api -X POST "repos/${repo}/environments/npm/deployment-branch-policies" -f name=main -f type=branch >/dev/null
fi

echo "3. and 4. Branch and tag rules"
ruleset "main" '{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "Test (Node 22)" }, { "context": "Test (Node 24)" }, { "context": "Test (Node 26)" } ] } }
  ]
}'
ruleset "version tags" '{
  "name": "version tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [{ "type": "deletion" }, { "type": "update" }]
}'

echo "Done."
