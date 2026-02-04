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

type FileChange = {
  filename: string;
  patch: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
};

type DiffHunk = {
  filename: string;
  oldStart: number;
  newStart: number;
  oldLines: number;
  newLines: number;
  content: string;
  position: number;
  lastChangedLine: number;
};

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
  ref: string,
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
    console.error(`Error fetching content for ${filename}`, error);
    return null;
  }
}

/* 
  parseDiffIntoHunks function parses a file's diff patch into individual hunks (change sections).
  
  A "hunk" represents a specific section of code that was modified in the diff.
  Each hunk has a header like "@@ -19,8 +19,9 @@" that indicates:
  - Where the change starts in the old/new file
  - How many lines are affected
  - The actual changed lines (additions/deletions/context)
 
  This function:
  1. Splits the patch into individual lines
  2. Identifies hunk headers (lines starting with @@)
  3. Groups subsequent lines under each hunk
  4. Tracks the last line number where a '+' (addition) occurred for inline comment placement
  
  example
  Input patch:
  "@@ -19,8 +19,9 @@
    const username = req.body.username;
  -  if (password.length < 6) {
  +  if (password.length < 8) {
  +    console.log("Checking password");
  "
  
  Output:
  [{
    filename: "auth.ts",
    oldStart: 19, oldLines: 8,
    newStart: 19, newLines: 9,
    content: "...",
    lastChangedLine: 21  // Line where the last '+' appeared
  }]
*/

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

      const [, oldStart, oldLines, newStart, newLines] = hunkMatch;

      currentNewStart = parseInt(newStart);
      currentHunk = {
        filename: fileChange.filename,
        oldStart: parseInt(oldStart),
        oldLines: parseInt(oldLines || "1"),
        newStart: parseInt(newStart),
        newLines: parseInt(newLines || "1"),
        content: line + "\n",
        position: position,
        lastChangedLine: currentNewStart,
      };
    } else if (currentHunk) {
      currentHunk.content += line + "\n";
      if (line.startsWith("+")) {
        currentHunk.lastChangedLine = currentNewStart;
        currentNewStart++;
      } else if (line.startsWith(" ")) {
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
  fileContext: string | null,
): Promise<string | null> {
  try {
    const contextInfo = fileContext
      ? `\n\nFull file context (for reference):\n\`\`\`\n${fileContext.slice(0, 5000)}\n\`\`\``
      : `\n\nFile context is unavailable. Review based on the changes shown.`;

    const instruction = `You are a senior software engineer doing a code review.
CRITICAL RULES:
1. ONLY comment if you find a REAL, SIGNIFICANT issue (bugs, security vulnerabilities, incorrect logic, breaking changes)
2. DO NOT comment on:
   - Style preferences (missing newlines, formatting, indentation)
   - Minor suggestions or "nice-to-haves"
   - Best practices unless they create actual problems
   - Obvious or trivial observations
3. Focus on HIGH-IMPACT issues only
4. Do not hallucinate, always use documentations or official references and provide links.
5. Dont comment on files like .gitignore, terraform.lock.hcl, package-lock.json etc
6. NO bullet points, NO multiple suggestions, NO "considerations"

If you find a significant issue:
- State the problem clearly in 1-2 sentences
- Explain why it's a problem (inconsistency, bug, security risk)
- Suggest a specific fix

Example of a GOOD review:
"The protection_bypass_for_automation is set to false, but var.x_vercel_protection_bypass is defined and used in locals.tf. This inconsistency means the bypass token won't work as intended. Suggested change: protection_bypass_for_automation = var.x_vercel_protection_bypass"

Example of reviews to AVOID:
- "Add a newline at end of file"
- "Consider using semantic versioning"
- "Improve comment clarity"

${isLocalMode ? "" : "Write the comment in GitHub Markdown format."}`;

    const input = `File: ${hunk.filename}
Change at line ${hunk.newStart}:

\`\`\`diff
${hunk.content}
\`\`\`${contextInfo}`;

    console.log(
      `  Reviewing hunk in ${hunk.filename} at line ${hunk.newStart}...`,
    );

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
  commitId: string,
): Promise<void> {
  try {
    if (isDryRun) {
      console.log(
        `  [DRY RUN] Would post comment on ${filename} at line ${line}`,
      );
      console.log(`  Comment: ${comment}\n`);
      return;
    }
    const { data: comments } = await octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
    });

    const existingComment = comments.find(
      (comment) =>
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
        line: line,
      });
      console.log("Created new AI review comment");
    }
  } catch (error) {
    console.error("Error posting/updating review:", error);
    console.log(filename, commitId, line);
    throw error;
  }
}

/**
 * Fetches PR metadata including commit ID and base branch reference.
 */
async function fetchPrMetadata(prNumber: number): Promise<{
  commitId: string;
  baseRef: string;
}> {
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  return {
    commitId: pr.head.sha,
    baseRef: pr.base.ref,
  };
}

/**
 * Gets the list of changed files in a PR.
 */
async function getChangedFilesList(prNumber: number): Promise<FileChange[]> {
  const files = await fetchPrFiles(prNumber);
  console.log(` Found ${files.length} changed file(s)\n`);
  return files;
}

/**
 * Reviews a single file and posts inline comments.
 * Returns the number of comments posted.
 */
async function reviewFile(
  file: FileChange,
  prNumber: number,
  commitId: string,
  baseRef: string,
): Promise<number> {
  if (!file.patch) {
    console.log(`Skipping ${file.filename} (no patch)`);
    return 0;
  }

  console.log(
    `\n Reviewing ${file.filename} (+${file.additions} -${file.deletions})`,
  );

  let fileContext: string | null = null;

  if (file.status === "added") {
    console.log(`New file - no base context available`);
    fileContext = null;
  } else if (file.status === "removed") {
    console.log(`Deleted file - skipping review`);
    return 0;
  } else if (file.status === "renamed") {
    console.log(`Renamed file - reviewing changes only`);
    fileContext = null;
  } else {
    fileContext = await fetchFileContent(file.filename, baseRef);

    if (!fileContext) {
      console.log(
        `Could not fetch base file content, reviewing without context`,
      );
    }
  }
  const hunks = parseDiffIntoHunks(file);
  console.log(`Found ${hunks.length} hunk(s)`);

  let commentsPosted = 0;

  for (const hunk of hunks) {
    const review = await getAIReview(hunk, fileContext);

    if (review) {
      await postOrUpdateInlineComment(
        prNumber,
        file.filename,
        hunk.lastChangedLine,
        review,
        commitId,
      );
      commentsPosted++;
    }
  }
  return commentsPosted;
}

/**
 * Reviews a pull request by analyzing each changed file and posting inline AI comments.
 */
async function reviewPrWithInlineComments(prNumber: number): Promise<void> {
  console.log("\n Starting inline code review...\n");
  if (isDryRun) {
    console.log("DRY RUN MODE, No comments will be posted on GitHub\n");
  }

  const { commitId, baseRef } = await fetchPrMetadata(prNumber);
  const files = await getChangedFilesList(prNumber);

  let totalComments = 0;

  for (const file of files) {
    const commentsForFile = await reviewFile(file, prNumber, commitId, baseRef);
    totalComments += commentsForFile;
  }

  console.log(
    `\n Review complete! ${isDryRun ? "Would post" : "Posted"} ${totalComments} inline comment(s)`,
  );
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
