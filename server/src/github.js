import axios from 'axios';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

// In-memory cache for repositories and file trees (TTL: 10 minutes)
const cache = new Map();

/**
 * Builds request headers for GitHub API, dynamically reloading server/.env.
 */
function getHeaders() {
  try {
    dotenv.config({ override: true });
  } catch {}

  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'RepoPilot-AI',
  };

  const token = process.env.GITHUB_TOKEN;
  if (token && token.trim() && token !== 'your_github_token_here' && !token.startsWith('your_')) {
    headers['Authorization'] = `Bearer ${token.trim()}`;
  }

  return headers;
}

const COMMON_SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.rb', '.php', '.md', '.markdown', '.json',
  '.html', '.css', '.scss', '.yaml', '.yml', '.sql',
  '.sh', '.bash', '.toml', '.xml', '.vue', '.svelte',
  '.swift', '.kt', '.scala',
]);

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.github',
  '.next',
  '.nuxt',
  'coverage',
  'vendor',
  'venv',
  '.venv',
  'env',
  '__pycache__',
  '.idea',
  '.vscode',
  'out',
  'bin',
  'obj',
  'target',
]);

/**
 * Calculates a priority score for sorting files.
 * Lower score = higher priority.
 */
function getFilePriority(filePath) {
  const lowerPath = filePath.toLowerCase();
  const fileName = lowerPath.split('/').pop();

  // Priority 1: README files
  if (fileName.startsWith('readme')) {
    return 1;
  }

  // Priority 2: Manifest & dependency files
  const packageFiles = [
    'package.json',
    'requirements.txt',
    'pyproject.toml',
    'cargo.toml',
    'go.mod',
    'pom.xml',
    'build.gradle',
    'gemfile',
    'composer.json',
  ];
  if (packageFiles.includes(fileName)) {
    return 2;
  }

  // Priority 3: Common entrypoints
  if (
    fileName.startsWith('index.') ||
    fileName.startsWith('main.') ||
    fileName.startsWith('app.') ||
    fileName.startsWith('server.')
  ) {
    return 3;
  }

  // Priority 4: Root-level source files
  if (!lowerPath.includes('/')) {
    return 4;
  }

  // Priority 5: Nested source files
  return 5;
}

/**
 * Fetches repository metadata from GitHub.
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<{name: string, description: string, language: string, stars: number, default_branch: string, html_url: string}>}
 */
export async function getRepository(owner, repo) {
  const cacheKey = `repo:${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 10 * 60 * 1000) {
    return cached.data;
  }

  try {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}`;
    const response = await axios.get(url, {
      headers: getHeaders(),
    });

    const data = response.data;
    const result = {
      name: data.name,
      description: data.description || '',
      language: data.language || '',
      stars: data.stargazers_count ?? 0,
      default_branch: data.default_branch || 'main',
      html_url: data.html_url || `https://github.com/${owner}/${repo}`,
    };

    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  } catch (err) {
    // If rate-limited (403), fallback to GitHub's public web interface to avoid blocking
    if (err.response?.status === 403 || err.response?.status === 429) {
      console.warn(`[RepoPilot] GitHub API rate-limited for ${owner}/${repo}. Falling back to public web interface.`);
      try {
        const webUrl = `https://github.com/${owner}/${repo}`;
        const webRes = await axios.get(webUrl, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        });
        const payload = webRes.data?.payload || {};
        const route = payload.codeViewRepoRoute || payload.treeRepoRoute || {};
        const default_branch = route.refInfo?.name || 'main';
        const title = webRes.data?.meta?.title || '';
        let description = '';
        if (title.includes(':')) {
          description = title.split(':').slice(1).join(':').trim();
        }

        const result = {
          name: repo,
          description,
          language: '',
          stars: 0,
          default_branch,
          html_url: `https://github.com/${owner}/${repo}`,
        };

        cache.set(cacheKey, { data: result, timestamp: Date.now() });
        return result;
      } catch (fallbackErr) {
        throw new Error(
          `GitHub API rate limit exceeded for your IP. To increase your limit from 60 to 5,000 requests/hour, please add a free GitHub Personal Access Token to server/.env (GITHUB_TOKEN=ghp_...).`
        );
      }
    }
    throw err;
  }
}

/**
 * Fetches source files for repository.
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<{repository: object, files: Array<{path: string, content: string, size: number}>}>}
 */
export async function getSourceFiles(owner, repo) {
  const cacheKey = `files:${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 10 * 60 * 1000) {
    return cached.data;
  }

  const repository = await getRepository(owner, repo);
  const branch = repository.default_branch || 'main';

  let tree = [];
  try {
    const treeUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
    const treeResponse = await axios.get(treeUrl, {
      headers: getHeaders(),
    });
    tree = treeResponse.data.tree || [];
  } catch (err) {
    // If rate-limited, fallback to items extracted from GitHub web JSON or common repository files
    if (err.response?.status === 403 || err.response?.status === 429) {
      console.warn(`[RepoPilot] Git trees API rate-limited for ${owner}/${repo}. Falling back to web tree and common manifests.`);
      try {
        const webUrl = `https://github.com/${owner}/${repo}`;
        const webRes = await axios.get(webUrl, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        });
        const items = webRes.data?.payload?.codeViewRepoRoute?.tree?.items || [];
        tree = items.map((i) => ({
          path: i.path,
          type: i.contentType === 'directory' ? 'tree' : 'blob',
          size: 1000,
        }));
      } catch {}

      // Supplement with standard candidate files if tree is small
      const standardCandidates = [
        'README.md', 'Readme.md', 'README',
        'package.json', 'requirements.txt', 'pyproject.toml',
        'Cargo.toml', 'go.mod', 'pom.xml',
        'index.js', 'main.py', 'src/index.js', 'src/main.js', 'src/App.jsx'
      ];
      for (const cand of standardCandidates) {
        if (!tree.some((t) => t.path.toLowerCase() === cand.toLowerCase())) {
          tree.push({ path: cand, type: 'blob', size: 1000 });
        }
      }
    } else {
      throw err;
    }
  }

  // Filter tree items
  const filteredItems = tree.filter((item) => {
    // Only include blobs (files)
    if (item.type !== 'blob') return false;

    // Limit size <= 20000 bytes
    if (typeof item.size === 'number' && item.size > 20000) return false;

    const segments = item.path.split('/');
    // Check if any parent directory is ignored
    const isInIgnoredDir = segments
      .slice(0, -1)
      .some((seg) => IGNORED_DIRECTORIES.has(seg.toLowerCase()));
    if (isInIgnoredDir) return false;

    // Filter by extension or recognized filename
    const ext = path.extname(item.path).toLowerCase();
    const fileName = segments[segments.length - 1].toLowerCase();
    const isSource =
      COMMON_SOURCE_EXTENSIONS.has(ext) ||
      fileName.startsWith('readme') ||
      fileName === 'dockerfile' ||
      fileName === 'makefile';

    return isSource;
  });

  // Sort to prioritize README/package files
  filteredItems.sort((a, b) => {
    const priorityDiff = getFilePriority(a.path) - getFilePriority(b.path);
    if (priorityDiff !== 0) return priorityDiff;
    return a.path.localeCompare(b.path);
  });

  // Slice top 12 results
  const top12Items = filteredItems.slice(0, 12);

  // Fetch individual file contents (using raw.githubusercontent.com first to bypass API rate limits)
  const files = [];
  for (const item of top12Items) {
    try {
      let content = null;

      // Strategy 1: Fetch directly from raw.githubusercontent.com (uses ZERO API quota!)
      try {
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${item.path}`;
        const rawRes = await axios.get(rawUrl, {
          responseType: 'text',
          timeout: 4000,
          headers: { 'User-Agent': 'RepoPilot-AI' },
        });
        if (typeof rawRes.data === 'string' && rawRes.data.length > 0) {
          content = rawRes.data;
        } else if (typeof rawRes.data === 'object') {
          content = JSON.stringify(rawRes.data, null, 2);
        }
      } catch {}

      // Strategy 2: Fallback to GitHub Contents API if raw download didn't succeed
      if (!content) {
        const encodedPath = item.path
          .split('/')
          .map(encodeURIComponent)
          .join('/');
        const contentUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodedPath}`;
        const contentResponse = await axios.get(contentUrl, {
          params: { ref: branch },
          headers: getHeaders(),
          timeout: 5000,
        });

        const data = contentResponse.data;
        if (data && data.content && data.encoding === 'base64') {
          content = Buffer.from(data.content, 'base64').toString('utf8');
        }
      }

      if (content) {
        files.push({
          path: item.path,
          content,
          size: item.size || content.length,
        });
      }
    } catch (err) {
      console.warn(`[RepoPilot] Skipped file ${item.path} due to fetch error:`, err.message);
    }
  }

  const result = {
    repository,
    files,
  };

  cache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}

export default {
  getRepository,
  getSourceFiles,
};
