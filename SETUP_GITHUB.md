# GitHub One-Time Setup (Pre-Code Gate D2)

The repository currently exists only in this sandbox. Before application code, it must be pushed to a founder-owned GitHub private repo.

## Option A — Founder creates a Personal Access Token (PAT) and provides it to engineering

1. Founder (logged into GitHub as the company/founder account):
   - Create a new **private** repository at https://github.com/new
     - Owner: your personal or company GitHub account
     - Repository name: `scolaira` (suggested, or `scolaira-app`)
     - Do NOT initialize with README/.gitignore (we already have them)
   - Create a PAT: https://github.com/settings/tokens/new
     - Note: `scolaira-arena-setup`
     - Expiration: choose 7 days (or longer as comfortable)
     - Scopes: `repo` (full repo control)
   - Provide to engineering:
     - The repository URL (e.g. `https://github.com/scolaira/scolaira.git`)
     - The PAT string

2. Engineering will then run:
   ```bash
   cd /home/user/scolaira
   git remote add origin https://x-access-token:<THE_PAT>@github.com/<OWNER>/<REPO>.git
   git push -u origin main
   git ls-remote   # verify
   ```

## Option B — Founder pairs with engineering via `gh` CLI

If `gh` is installed and authenticated in this environment, engineering can run:
```bash
gh auth login
gh repo create scolaira/scolaira --private --source=. --remote=origin --push
```
But `gh` is not installed in this sandbox and we lack sudo to install it, so Option A is the straightforward path.

## Option C — Founder pushes from their own machine

```bash
# Clone this workspace to your machine (or copy the directory out)
git clone <workspace-copy>/scolaira
cd scolaira
git remote add origin https://github.com/<OWNER>/<REPO>.git
git push -u origin main
```

## After Remote Is Verified

Engineering will confirm:
- `git remote -v` shows the GitHub URL.
- `git ls-remote origin` returns the current commit `4b55e69`.
- https://github.com/<OWNER>/<REPO> shows README.md and docs/ folder in the web UI.
- Default branch is `main`.
- Branch protection enabled on `main` (PR required, status checks will be added as CI lands).

**Only then does scaffolding begin.**
