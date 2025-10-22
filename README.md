# Oak AI PR Reviewer
An automated AI-powered code review tool that provides feedback on pull requests.

## How It Works
It fetches PR diffs from GitHub API, sends it to OpenAI's GPT-4 to analyze and provides structured review.

## Quick Start
This currently runs locally.
- Clone the repository; `git clone https://github.com/oaknational/oak-ai-pr-reviewer.git` ->
   `cd ai-pr-reviewer`
- Install dependencies; `npm ci`
- Set up environment variables; Create an `.env` file, `cp sample.env .env`. Edit `.env` and add your credentials.
- Run a review; `npm run start:local <pr number>`.