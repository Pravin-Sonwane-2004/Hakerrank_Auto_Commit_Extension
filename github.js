(function exposeGitHub(global) {
  "use strict";

  const Utils = global.HRGitHubSyncUtils;
  const API_BASE = "https://api.github.com";
  const API_VERSION = "2026-03-10";

  function encodePath(path) {
    return String(path || "")
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
  }

  class GitHubClient {
    constructor(settings) {
      const merged = Utils.mergeSettings(settings);
      this.token = merged.githubToken;
      this.owner = merged.owner;
      this.repo = merged.repo;
      this.branch = merged.branch || "main";
    }

    assertConfigured() {
      const missing = [];

      if (!this.token) missing.push("GitHub token");
      if (!this.owner) missing.push("repository owner");
      if (!this.repo) missing.push("repository name");
      if (!this.branch) missing.push("branch name");

      if (missing.length) {
        throw new Error(`Missing settings: ${missing.join(", ")}`);
      }
    }

    async request(path, options = {}) {
      this.assertConfigured();

      const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": API_VERSION,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {})
        }
      });

      const text = await response.text();
      const payload = text ? safeJson(text) : null;

      if (!response.ok) {
        const message = payload && payload.message ? payload.message : response.statusText;
        const error = new Error(`GitHub API ${response.status}: ${message}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }

      return payload;
    }

    async getRepository() {
      return this.request(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`);
    }

    async getBranch() {
      return this.request(
        `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/branches/${encodeURIComponent(this.branch)}`
      );
    }

    async getFile(path) {
      try {
        return await this.request(
          `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(this.branch)}`
        );
      } catch (error) {
        if (error.status === 404) {
          return null;
        }

        throw error;
      }
    }

    async createOrUpdateFile({ path, content, message }) {
      const normalizedContent = Utils.normalizeCodeForCommit(content);
      const existingFile = await this.getFile(path);

      if (existingFile && existingFile.type !== "file") {
        throw new Error(`GitHub path exists but is not a file: ${path}`);
      }

      if (existingFile && existingFile.content) {
        const remoteContent = Utils.base64ToUtf8(existingFile.content);

        // Avoid a no-op commit when GitHub already has the accepted solution.
        if (Utils.normalizeCodeForCommit(remoteContent) === normalizedContent) {
          return {
            action: "unchanged",
            path,
            htmlUrl: existingFile.html_url || "",
            sha: existingFile.sha || ""
          };
        }
      }

      const body = {
        branch: this.branch,
        content: Utils.utf8ToBase64(normalizedContent),
        message
      };

      if (existingFile && existingFile.sha) {
        // GitHub's Contents API requires the current blob SHA when replacing a file.
        body.sha = existingFile.sha;
      }

      const result = await this.request(
        `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodePath(path)}`,
        {
          method: "PUT",
          body: JSON.stringify(body)
        }
      );

      return {
        action: existingFile ? "updated" : "created",
        path,
        htmlUrl: result.content && result.content.html_url ? result.content.html_url : "",
        commitSha: result.commit && result.commit.sha ? result.commit.sha : "",
        sha: result.content && result.content.sha ? result.content.sha : ""
      };
    }

    async testConnection() {
      const [repository, branch] = await Promise.all([
        this.getRepository(),
        this.getBranch()
      ]);

      return {
        fullName: repository.full_name,
        branch: branch.name
      };
    }
  }

  function safeJson(text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  global.HRGitHubSyncGitHub = Object.freeze({
    API_VERSION,
    GitHubClient
  });
})(globalThis);
