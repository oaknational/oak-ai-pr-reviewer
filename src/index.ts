import { Octokit } from "@octokit/rest";
import OpenAI from "openai";
import * as dotenv from "dotenv";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY!;

if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN not set");
if (!GITHUB_REPOSITORY) throw new Error("GITHUB_REPOSITORY not set");

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const client = new OpenAI({ apiKey: OPENAI_API_KEY });
const [owner, repo] = GITHUB_REPOSITORY.split("/");
console.log("Repo:", owner, repo);

async function fetchPrDiff(prNumber: number): Promise<string> {
  const result = await octokit.rest.pulls.get({
    owner: owner,
    repo: repo,
    pull_number: prNumber,
    mediaType: { format: "diff" },
  });

  return String(result.data);
}

async function main() {
  if (!process.argv[2]) {
    throw new Error(`
    PR number is required!

    Usage:
    npm run start:local <pr-number>

    Example:
    npm run start:local 3773

    Please provide a valid PR number as the first argument.
    `);
  }

  const prNumber = Number(process.argv[2]);
  if (isNaN(prNumber) || prNumber <= 0) {
    throw new Error(`
    Invalid PR number: "${process.argv[2]}"

    Please provide a valid positive number as the PR number.
    Example:
    npm run start:local 3773
    `);
  }

  console.log("Fetching diff for PR", prNumber);
  const diff = await fetchPrDiff(prNumber);

  const instruction = `You are a senior software engineer doing a code review. 
          Analyze the provided git diff and give constructive feedback focusing on:
          - Code quality and best practices
          - Potential bugs or issues
          - Performance considerations
          - Security concerns
          - Maintainability
          - Keep your review concise and actionable. If the changes look good, say so briefly
          - Write the comment in GitHub Markdown format.`;

  console.log("Getting AI review...");
  const response = await client.responses.create({
    model: "gpt-4o",
    instructions: instruction,
    input: diff,
  });
  const reviewText = response.output_text;

  console.log(reviewText);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
