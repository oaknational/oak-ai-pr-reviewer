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

const isLocalMode = !process.env.PR_NUMBER;
const isDryRun = process.env.DRY_RUN === "true";

interface FileChange {
  filename: string;
  patch: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

interface DiffHunk {
  filename: string;
  oldStart: number;
  newStart: number;
  oldLines: number;
  newLines: number;
  content: string;
  position: number;
  lastChangedLine: number;
}

async function fetchPrFiles(prNumber: number): Promise<FileChange[]> {
  const { data: files } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
  });

  return files.map((file) => ({
    filename: file.filename,
    patch: file.patch || "",
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
  }));
}

async function fetchFileContent(
  filename: string,
  ref: string
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filename,
      ref,
    });

    if ("content" in data) {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    return null;
  } catch (error) {
    return null;
  }
}

function parseDiffIntoHunks(fileChange: FileChange): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = fileChange.patch.split("\n");

  let currentHunk: DiffHunk | null = null;
  let position = 0;
  let currentNewStart = 0;

  for (const line of lines) {
    position++;

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);

    if (hunkMatch) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }

      currentNewStart = parseInt(hunkMatch[3]);
      currentHunk = {
        filename: fileChange.filename,
        oldStart: parseInt(hunkMatch[1]),
        oldLines: parseInt(hunkMatch[2] || "1"),
        newStart: parseInt(hunkMatch[3]),
        newLines: parseInt(hunkMatch[4] || "1"),
        content: line + "\n",
        position: position,
        lastChangedLine: currentNewStart,
      };
    } else if (currentHunk) {
      currentHunk.content += line + "\n";
      if (line.startsWith('+')) {
        currentHunk.lastChangedLine = currentNewStart;
        currentNewStart++;
      } else if (line.startsWith(' ')) {
        currentNewStart++;
      }
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }
  return hunks;
}

async function getAIReview(
  hunk: DiffHunk,
  fileContext: string | null
): Promise<string | null> {
  try {
    const contextInfo = fileContext
      ? `\n\nFull file context (for reference):\n\`\`\`\n${fileContext.slice(0, 5000)}\n\`\`\``
      : "";

    const instruction = `You are a senior software engineer doing a code review.
Analyze this specific code change and provide constructive feedback if there are issues. Do not hallucinate, always use documentations or official references and provide links.
Focus on:
- Code quality issues
- Best practice violations
- Potential bugs or logical errors
- Performance problems
- Security vulnerabilities
- Maintainability

IMPORTANT:
- Keep comments very concise and actionable with maximum 2-4 sentences total.
- Be specific about the issue and suggest a fix
${isLocalMode ? "" : "Write the comment in GitHub Markdown format."}`;

    const input = `File: ${hunk.filename}
Change at line ${hunk.newStart}:

\`\`\`diff
${hunk.content}
\`\`\`${contextInfo}`;

    console.log(`  Reviewing hunk in ${hunk.filename} at line ${hunk.newStart}...`);

    console.log("Getting AI review...");
    const response = await client.responses.create({
      model: "gpt-4o",
      instructions: instruction,
      input: input,
    });
    return response.output_text || "Unable to generate review.";
  } catch (error) {
    console.error("Error reviewing", error);
    throw error;
  }
}

async function postOrUpdateInlineComment(
  prNumber: number,
  filename: string,
  line: number,
  comment: string,
  commitId: string
): Promise<void> {
  try {
    if (isDryRun) {
      console.log(`  [DRY RUN] Would post comment on ${filename} at line ${line}`);
      console.log(`  Comment: ${comment}\n`);
      return;
    }
    const { data: comments } = await octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
    });

    const existingComment = comments.find((comment) =>
      comment.path === filename &&
      comment.line === line &&
      comment.body?.includes("<!-- AI-REVIEW-COMMENT -->"),
    );

    const versionMatch = existingComment?.body?.match(/\(v(\d+)\)/);
    const version = versionMatch ? parseInt(versionMatch[1]) + 1 : 1;
    const commentBody = existingComment
      ? `<!-- AI-REVIEW-COMMENT -->
           AI Code Review (v${version})\n\n${comment}`

      : `<!-- AI-REVIEW-COMMENT -->
           AI Code Review (v1)\n\n${comment}`;

    if (existingComment) {
      await octokit.rest.pulls.updateReviewComment({
        owner,
        repo,
        comment_id: existingComment.id,
        body: commentBody,
      });
      console.log(`Updated existing AI review comment: ${existingComment.id}`);
    } else {
      await octokit.rest.pulls.createReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        body: commentBody,
        commit_id: commitId,
        path: filename,
        line: line
      });
      console.log("Created new AI review comment");

    }
  } catch (error) {
    console.error("Error posting/updating review:", error);
    console.log(filename, commitId, line);
    throw error;
  }
}

async function reviewPrWithInlineComments(prNumber: number): Promise<void> {
  console.log("\n Starting inline code review...\n");
  if (isDryRun)
    console.log("DRY RUN MODE, No comments will be posted on GitHub\n");

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const commitId = pr.head.sha;
  const baseRef = pr.base.ref;

  const files = await fetchPrFiles(prNumber);
  console.log(` Found ${files.length} changed file(s)\n`);

  let totalComments = 0;

  for (const file of files) {
    if (!file.patch) {
      console.log(`Skipping ${file.filename} (no patch)`);
      continue;
    }

    console.log(`\n Reviewing ${file.filename} (+${file.additions} -${file.deletions})`);

    const fileContext = await fetchFileContent(file.filename, baseRef);
    const hunks = parseDiffIntoHunks(file);
    console.log(`  Found ${hunks.length} hunk`);

    for (const hunk of hunks) {

      const review = await getAIReview(hunk, fileContext);

      if (review) {
        await postOrUpdateInlineComment(
          prNumber,
          file.filename,
          hunk.lastChangedLine,
          review,
          commitId
        );
        totalComments++;
      }
    }
  }
  console.log(`\n Review complete! ${isDryRun ? "Would post" : "Posted"} ${totalComments} inline comment(s)`);
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

    Without posting on GH (dry run):
    DRY_RUN=true npm run start:local 3773

    With posting:
    npm run start:local 3773
    `);
  }

  console.log("Reviewing PR", prNumber);
  await reviewPrWithInlineComments(prNumber);
}

async function runGitHubActionsMode(): Promise<void> {
  const prNumber = parseInt(process.env.PR_NUMBER!);

  console.log("Reviewing PR", prNumber);
  await reviewPrWithInlineComments(prNumber);

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