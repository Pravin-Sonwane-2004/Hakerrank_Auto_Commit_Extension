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
      const errors = Utils.validateGitHubSettings({
        githubToken: this.token,
        owner: this.owner,
        repo: this.repo,
        branch: this.branch
      });

      if (errors.length) {
        throw new Error(`Check settings: ${errors.join(", ")}.`);
      }
    }

    async request(path, options = {}) {
      this.assertConfigured();
      const {
        forbiddenMessage,
        notFoundMessage,
        ...fetchOptions
      } = options;

      const response = await fetch(`${API_BASE}${path}`, {
        ...fetchOptions,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": API_VERSION,
          ...(fetchOptions.body ? { "Content-Type": "application/json" } : {}),
          ...(fetchOptions.headers || {})
        }
      });

      const text = await response.text();
      const payload = text ? safeJson(text) : null;

      if (!response.ok) {
        const apiMessage = payload && payload.message ? payload.message : response.statusText;
        const message = friendlyGitHubMessage(response.status, apiMessage, {
          forbiddenMessage,
          notFoundMessage
        });
        const error = new Error(`GitHub API ${response.status}: ${message}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }

      return payload;
    }

    async getRepository() {
      return this.request(
        `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`,
        {
          notFoundMessage: `Repository ${this.owner}/${this.repo} was not found, or the token cannot access it. Check the owner, repository name, and selected token repositories.`,
          forbiddenMessage: `Token cannot read repository ${this.owner}/${this.repo}. Check the token permissions.`
        }
      );
    }

    async getBranch() {
      return this.request(
        `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/branches/${encodeURIComponent(this.branch)}`,
        {
          notFoundMessage: `Branch ${this.branch} was not found in ${this.owner}/${this.repo}, or the token cannot access the repository.`,
          forbiddenMessage: `Token cannot read branch ${this.branch} in ${this.owner}/${this.repo}. Check the token permissions.`
        }
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
          body: JSON.stringify(body),
          notFoundMessage: `Could not write ${path} to ${this.owner}/${this.repo} on branch ${this.branch}. Check that the repository and branch exist and that the token can access this repository.`,
          forbiddenMessage: `Token cannot write ${path} to ${this.owner}/${this.repo}. Give the token Contents read and write access.`
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
      const repository = await this.getRepository();
      const branch = await this.getBranch();

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

  function friendlyGitHubMessage(status, apiMessage, options = {}) {
    if (status === 404 && options.notFoundMessage) {
      return `${options.notFoundMessage} GitHub returned: ${apiMessage}.`;
    }

    if (status === 403 && options.forbiddenMessage) {
      return `${options.forbiddenMessage} GitHub returned: ${apiMessage}.`;
    }

    return apiMessage;
  }

  global.HRGitHubSyncGitHub = Object.freeze({
    API_VERSION,
    GitHubClient
  });
})(globalThis);
