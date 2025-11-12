import { Octokit } from "@octokit/rest";
import OpenAI from "openai";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

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

const isLocalMode = !process.env.PR_NUMBER;

async function fetchPrDiff(prNumber: number): Promise<string> {
  const result = await octokit.rest.pulls.get({
    owner: owner,
    repo: repo,
    pull_number: prNumber,
    mediaType: { format: "diff" },
  });

  return String(result.data);
}

async function getAIReview(diff: string): Promise<string> {
  try {
    const instruction = `You are a senior software engineer doing a code review.
Analyze the provided git diff and give constructive feedback focusing on:
- Code quality and best practices
- Potential bugs or issues
- Performance considerations
- Security concerns
- Maintainability

Keep your review concise and actionable. If the changes look good, say so briefly.
${isLocalMode ? "" : "Write the comment in GitHub Markdown format."}`;

    console.log("Getting AI review...");
    const response = await client.responses.create({
      model: "gpt-4o",
      instructions: instruction,
      input: diff,
    });
    return response.output_text || "Unable to generate review.";
  } catch (error) {
    console.error("Error calling OpenAI:", error);
    throw error;
  }
}
async function postOrUpdateReview(
  owner: string,
  repo: string,
  prNumber: number,
  reviewContent: string,
): Promise<void> {
  try {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
    });

    const existingComment = comments.find((comment) =>
      comment.body?.includes("<!-- AI-REVIEW-COMMENT -->"),
    );

    const commentBody = `<!-- AI-REVIEW-COMMENT -->
          ## AI Code Review

${reviewContent}
`;
    if (existingComment) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existingComment.id,
        body: commentBody,
      });
      console.log(`Updated existing AI review comment: ${existingComment.id}`);
    } else {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: commentBody,
      });
      console.log("Created new AI review comment");
    }
  } catch (error) {
    console.error("Error posting/updating review:", error);
    throw error;
  }
}

async function runLocalMode(): Promise<void> {
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

  const reviewText = await getAIReview(diff);
  console.log(reviewText);
}

async function runGitHubActionsMode(): Promise<void> {
  const prNumber = parseInt(process.env.PR_NUMBER!);

  const diffPath = path.resolve(process.cwd(), "pr.diff");

  if (!fs.existsSync(diffPath)) {
    throw new Error("PR diff file not found");
  }

  const diff = fs.readFileSync(diffPath, "utf8");

  if (!diff.trim()) {
    console.log("No changes to review");
    return;
  }

  console.log("Getting AI review...");
  const reviewContent = await getAIReview(diff);

  console.log("Posting/updating review comment...");
  await postOrUpdateReview(owner, repo, prNumber, reviewContent);

  console.log("AI review completed successfully!");
}
async function main(): Promise<void> {
  try {
    console.log("Repo:", owner, repo);

    if (isLocalMode) {
      console.log("Running in LOCAL mode");
      await runLocalMode();
    } else {
      console.log("Running in GITHUB ACTIONS mode");
      await runGitHubActionsMode();
    }
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
