import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { getSourceFiles } from './github.js';
import { reviewWithGemma, roadmapWithGemini } from './ai.js';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '20kb' }));

/**
 * Parses a GitHub URL or string and extracts { owner, repo }.
 * Throws an Error for invalid inputs.
 * @param {string} value
 * @returns {{ owner: string, repo: string }}
 */
export function parseGitHubUrl(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('GitHub URL is required and must be a string.');
  }

  let cleaned = value.trim();
  if (!cleaned) {
    throw new Error('GitHub URL cannot be empty.');
  }

  // Normalize git SSH URLs or shorthand
  if (cleaned.startsWith('git@github.com:')) {
    cleaned = cleaned.replace('git@github.com:', 'https://github.com/');
  } else if (!/^https?:\/\//i.test(cleaned)) {
    if (cleaned.startsWith('github.com/')) {
      cleaned = `https://${cleaned}`;
    } else if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(cleaned)) {
      cleaned = `https://github.com/${cleaned}`;
    } else {
      cleaned = `https://${cleaned}`;
    }
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(cleaned);
  } catch {
    throw new Error(`Invalid URL format: "${value}".`);
  }

  if (parsedUrl.hostname !== 'github.com' && parsedUrl.hostname !== 'www.github.com') {
    throw new Error(`Invalid GitHub host "${parsedUrl.hostname}". Only github.com repositories are supported.`);
  }

  const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
  if (pathParts.length < 2) {
    throw new Error('GitHub URL must include both owner and repository name (e.g., https://github.com/owner/repo).');
  }

  const owner = pathParts[0].trim();
  let repo = pathParts[1].trim();

  if (repo.endsWith('.git')) {
    repo = repo.slice(0, -4);
  }

  if (!owner || !repo) {
    throw new Error('Unable to parse valid owner and repository name.');
  }

  return { owner, repo };
}

/**
 * Runs the review flow: parses URL, fetches source files, and reviews with Gemma.
 * @param {string} url
 * @returns {Promise<{ repository: object, files: Array<object>, review: object }>}
 */
export async function runReview(url) {
  const { owner, repo } = parseGitHubUrl(url);
  const { repository, files } = await getSourceFiles(owner, repo);
  const review = await reviewWithGemma(repository, files);
  return {
    repository,
    files,
    review,
  };
}

/**
 * Handles errors and formats appropriate HTTP responses.
 */
function handleError(res, err) {
  console.error('[RepoPilot Error]:', err?.message || err);

  const message = err?.message || 'An unexpected error occurred.';

  // Bad input / validation errors
  if (
    message.includes('GitHub URL') ||
    message.includes('Invalid URL') ||
    message.includes('Invalid GitHub') ||
    message.includes('must include both owner') ||
    message.includes('Unable to parse valid owner')
  ) {
    return res.status(400).json({ error: message });
  }

  // External API failures (GitHub API)
  if (err?.isAxiosError) {
    const upstreamStatus = err.response?.status;
    const upstreamMessage = err.response?.data?.message || err.response?.statusText || err.message;
    return res.status(502).json({
      error: `GitHub API error (${upstreamStatus || 'failed'}): ${upstreamMessage}`,
    });
  }

  // External AI model failures
  if (err?.status || err?.name?.includes('Google') || message.toLowerCase().includes('model')) {
    return res.status(502).json({
      error: `AI Service error: ${message}`,
    });
  }

  return res.status(500).json({ error: message });
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: "ok", app: "RepoPilot AI" });
});

// Review endpoint
app.post('/api/review', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) {
      return res.status(400).json({ error: 'GitHub repository URL is required.' });
    }

    const result = await runReview(url);
    return res.json(result);
  } catch (err) {
    return handleError(res, err);
  }
});

// Roadmap endpoint
app.post('/api/roadmap', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) {
      return res.status(400).json({ error: 'GitHub repository URL is required.' });
    }

    const reviewResult = await runReview(url);
    const roadmapResult = await roadmapWithGemini(reviewResult.repository, reviewResult.review);

    return res.json({
      repository: reviewResult.repository,
      review: reviewResult.review,
      roadmap: roadmapResult,
    });
  } catch (err) {
    return handleError(res, err);
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`RepoPilot AI server running on port ${PORT}`);
});

export default app;
