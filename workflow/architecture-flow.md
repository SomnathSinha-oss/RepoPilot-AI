# Architecture & Execution Workflows

This document outlines the detailed execution workflows, message sequences, state transitions, and component interactions of **RepoPilot AI**.

---

## 1. Code Review Sequence Workflow (`POST /api/review`)

The diagram below traces the end-to-end flow from the user entering a GitHub repository URL through code evaluation by Google Gemma:

```mermaid
sequenceDiagram
    autonumber
    actor User as User Browser
    participant Client as React Dashboard (client/)
    participant Proxy as Vite Dev Proxy (:5173)
    participant API as Express Router (server/src/index.js)
    participant GH as GitHub Service (server/src/github.js)
    participant GitHubAPI as GitHub REST API (api.github.com)
    participant AI as AI Engine (server/src/ai.js)
    participant Gemma as Google Gemma Model (gemma-4-26b-a4b-it)
    participant DB as Database / Cache

    User->>Client: Input GitHub URL & click "Review with Gemma ↗"
    Client->>Client: Set loading = "review", clear previous errors
    Client->>Proxy: POST /api/review { url }
    Proxy->>API: Forward request to Express (:5000)

    API->>API: parseGitHubUrl(url) -> { owner, repo }
    alt Invalid URL format or unsupported host
        API-->>Client: 400 Bad Request { error: "Invalid GitHub URL..." }
        Client->>User: Display error alert box
    end

    API->>GH: getSourceFiles(owner, repo)
    GH->>GitHubAPI: GET /repos/{owner}/{repo}
    GitHubAPI-->>GH: Repo metadata (name, stars, default_branch)

    GH->>DB: Check if tree & review are cached for commit SHA
    alt Cache Hit
        DB-->>GH: Return cached files & review
    else Cache Miss
        GH->>GitHubAPI: GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1
        GitHubAPI-->>GH: Recursive tree blobs
        GH->>GH: Filter ignored directories (node_modules, dist, .git)
        GH->>GH: Filter source extensions (.js, .py, .java, etc.) & size <= 20000 bytes
        GH->>GH: Sort by priority (README > package files > entrypoints)
        GH->>GH: Slice top 12 candidate files

        loop For each of the top 12 files
            GH->>GitHubAPI: GET /repos/{owner}/{repo}/contents/{path}?ref={branch}
            GitHubAPI-->>GH: Base64 encoded file payload
            GH->>GH: Buffer.from(content, 'base64').toString('utf8')
        end
    end

    GH-->>API: { repository, files }
    API->>AI: reviewWithGemma(repository, files)
    AI->>AI: Format files into single string (up to 40,000 characters)
    AI->>AI: Construct expert reviewer prompt (Architecture, Bugs, Findings, Fixes, Tests)
    AI->>Gemma: ai.models.generateContent({ model: gemmaModel, contents: prompt })
    Gemma-->>AI: Generated review report markdown
    AI-->>API: { model: gemmaModel, report: response.text }

    API->>DB: Store review report & repository metadata
    API-->>Proxy: 200 OK { repository, files, review }
    Proxy-->>Client: 200 OK
    Client->>Client: Update repository & review state, reset loading
    Client->>User: Render Repo Card & Gemma Review Article
```

---

## 2. Strategic Roadmap Sequence Workflow (`POST /api/roadmap`)

When a user requests a strategic engineering roadmap, the backend leverages Google Gemini to synthesize the previous review findings into an actionable phased plan:

```mermaid
sequenceDiagram
    autonumber
    actor User as User Browser
    participant Client as React Dashboard (client/)
    participant API as Express Server (:5000)
    participant AI as AI Engine (server/src/ai.js)
    participant Gemini as Google Gemini Model (gemini-1.5-flash)
    participant DB as Database / Cache

    User->>Client: Click "Generate roadmap with Gemini →"
    Client->>Client: Set loading = "roadmap", clear errors
    Client->>API: POST /api/roadmap { url }

    API->>API: runReview(url)
    Note over API,DB: Re-uses cached repository metadata & Gemma review if available
    API->>AI: roadmapWithGemini(repository, review)

    AI->>AI: Extract review markdown report
    AI->>AI: Construct Technical Lead & Architect prompt
    Note over AI: Formats Phase 1 (Immediate), Phase 2 (Short-Term), Phase 3 (Scaling), Metrics
    AI->>Gemini: ai.models.generateContent({ model: geminiModel, contents: prompt })
    Gemini-->>AI: Prioritized roadmap report markdown
    AI-->>API: { model: geminiModel, roadmap: response.text }

    API->>DB: Persist roadmap record linked to repository & review
    API-->>Client: 200 OK { repository, review, roadmap }
    Client->>Client: Update roadmap state, clear loading
    Client->>User: Render Gemini Strategic Roadmap Article
```

---

## 3. Frontend Dashboard State Machine

The client user interface manages deterministic state transitions across user actions and API responses:

```mermaid
stateDiagram-v2
    [*] --> Idle: Application Mount

    Idle --> ValidatingInput: User submits GitHub URL
    ValidatingInput --> Error: URL is empty or invalid
    ValidatingInput --> Reviewing: Valid URL submitted

    Reviewing --> Error: API responds 400 / 502 / Network Failure
    Reviewing --> ReviewReady: API responds 200 with { repository, review }

    ReviewReady --> Roadmapping: User clicks "Generate roadmap with Gemini →"
    ReviewReady --> Reviewing: User inputs new URL

    Roadmapping --> Error: API error on roadmap generation
    Roadmapping --> Complete: API responds 200 with { roadmap }

    Complete --> Reviewing: User inputs new repository URL
    Complete --> Roadmapping: User re-generates roadmap

    Error --> ValidatingInput: User updates URL & re-submits
```

---

## 4. File Ranking & Selection Pipeline

To optimize LLM context usage and ensure critical configuration/architecture files are analyzed first, `server/src/github.js` applies a multi-stage filtering and ranking algorithm:

```mermaid
flowchart TD
    Raw["Raw Git Tree Blobs\n(from /git/trees/:branch?recursive=1)"] --> F1{"Filter: Blob Type?"}
    F1 -->|No| Discard1["Discard Subtrees / Commits"]
    F1 -->|Yes| F2{"Filter: Ignored Directory?\n(node_modules, dist, .git, build, etc.)"}
    
    F2 -->|Yes| Discard2["Discard Dependencies & Artifacts"]
    F2 -->|No| F3{"Filter: Size <= 20,000 bytes?"}
    
    F3 -->|No| Discard3["Discard Large Blobs / Assets"]
    F3 -->|Yes| F4{"Filter: Source Extension?\n(.js, .ts, .py, .java, .md, etc.)"}
    
    F4 -->|No| Discard4["Discard Unknown Formats"]
    F4 -->|Yes| Rank["Apply Priority Scoring (1 to 5)"]

    Rank --> P1["Priority 1: README files\n(readme, readme.md, etc.)"]
    Rank --> P2["Priority 2: Manifest & Dependency Files\n(package.json, requirements.txt, Cargo.toml, go.mod, pom.xml)"]
    Rank --> P3["Priority 3: Key Entrypoints\n(index.*, main.*, app.*, server.*)"]
    Rank --> P4["Priority 4: Root Directory Source Files"]
    Rank --> P5["Priority 5: Nested Source Files"]

    P1 & P2 & P3 & P4 & P5 --> Sort["Sort by (Priority ASC, Path ASC)"]
    Sort --> Slice["Slice Top 12 Files"]
    Slice --> Fetch["Fetch Individual Contents via GitHub API & Decode Base64"]
    Fetch --> Truncate["Format up to 40,000 Chars for Gemma Review"]
```
