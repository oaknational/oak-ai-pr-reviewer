# Oak AI PR Reviewer
An automated AI-powered code review tool that provides inline review on pull requests.

## How It Works
It fetches PR diffs from GitHub API, sends it to OpenAI's GPT-4 to analyze and provides structured review. It uses comment versioning to avoid noise and keep PRs clean. Instead of creating new comments every time you run /ai-review, it updates existing comments in place.

## Quick Start
1. Add the Workflow File
Create .github/workflows/ai-pr-review.yml in your repository:
```
name: AI PR Review

on:
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write

concurrency:
  group: ai-pr-review-${{ github.event.issue.number }}
  cancel-in-progress: true

jobs:
  ai-review:
    if: github.event.issue.pull_request && contains(github.event.comment.body, '/ai-review')
    runs-on: ubuntu-latest
    
    steps:
      - name: AI Code Reviewer
        uses: oaknational/oak-ai-pr-reviewer/actions/pr_reviewer@main
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          comment_id: ${{ github.event.comment.id }}
```

### 2. Add OpenAI API Key

1. Go to your repository **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Name: `OPENAI_API_KEY`
4. Value: OpenAI API key (get one from [OpenAI Platform](https://platform.openai.com/api-keys))
5. Click **Add secret**

### 3. Use It!

On any pull request, comment:
```
/ai-review
The action will:
1. React with :eyes: (reviewing...)
2. Analyze all changed files
3. Post inline comments on issues found
4. React with "thumb up" when done.
```

To run locally.
- Clone the repository; `git clone https://github.com/oaknational/oak-ai-pr-reviewer.git` ->
   `cd ai-pr-reviewer`
- Install dependencies; `npm ci`
- Set up environment variables; Create an `.env` file, `cp sample.env .env`. Edit `.env` and add your credentials.
- Run a review. You can use dry run mode to preview reviews without posting them to GitHub. `npm run start:local:dry <pr_number>`. or post to GitHub using `npm run start:local <pr_number>`