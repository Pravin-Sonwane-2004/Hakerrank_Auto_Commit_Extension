importScripts("utils.js", "github.js");

const Utils = globalThis.HRGitHubSyncUtils;
const { GitHubClient } = globalThis.HRGitHubSyncGitHub;
const inFlightSubmissions = new Set();

lockStorageToTrustedContexts();

chrome.runtime.onInstalled.addListener(async () => {
  await lockStorageToTrustedContexts();
  const settings = await loadSettings();
  await Utils.storageSet({ [Utils.STORAGE_KEYS.settings]: settings });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((payload) => sendResponse({ ok: true, ...payload }))
    .catch((error) => {
      const messageText = Utils.toErrorMessage(error);
      console.error("[HackerRank GitHub Sync]", error);
      sendResponse({ ok: false, error: messageText });
    });

  return true;
});

async function handleMessage(message, sender) {
  switch (message && message.type) {
    case "HRGS_ACCEPTED_SUBMISSION":
      return syncSubmission(message.payload, {
        source: "automatic",
        force: false,
        tabId: sender && sender.tab ? sender.tab.id : null
      });

    case "HRGS_SYNC_SUBMISSION":
      return syncSubmission(message.payload, {
        source: "manual",
        force: Boolean(message.force),
        tabId: sender && sender.tab ? sender.tab.id : null
      });

    case "HRGS_GET_STATUS":
      return getStatus();

    case "HRGS_TEST_CONNECTION":
      return testConnection(message.settings);

    case "HRGS_READ_MONACO_FROM_TAB":
      return readMonacoFromTab(sender && sender.tab ? sender.tab.id : null);

    case "HRGS_CLEAR_HISTORY":
      await Utils.storageSet({ [Utils.STORAGE_KEYS.history]: [] });
      await saveLastStatus({ state: "idle", message: "History cleared.", timestamp: new Date().toISOString() });
      return getStatus();

    default:
      throw new Error(`Unknown message type: ${message && message.type ? message.type : "missing"}`);
  }
}

async function lockStorageToTrustedContexts() {
  try {
    if (chrome.storage && chrome.storage.local && chrome.storage.local.setAccessLevel) {
      // Keep the PAT out of content scripts. Options, popup, and service worker remain trusted contexts.
      await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    }
  } catch (error) {
    console.warn("[HackerRank GitHub Sync] Could not restrict storage access level.", error);
  }
}

async function loadSettings() {
  const data = await Utils.storageGet(Utils.STORAGE_KEYS.settings);
  return Utils.mergeSettings(data[Utils.STORAGE_KEYS.settings]);
}

async function loadHistory() {
  const data = await Utils.storageGet(Utils.STORAGE_KEYS.history);
  return Array.isArray(data[Utils.STORAGE_KEYS.history]) ? data[Utils.STORAGE_KEYS.history] : [];
}

async function saveHistory(history) {
  const trimmedHistory = history.slice(0, 200);
  await Utils.storageSet({ [Utils.STORAGE_KEYS.history]: trimmedHistory });
  return trimmedHistory;
}

async function saveLastStatus(status) {
  const normalized = {
    state: status.state || "idle",
    message: status.message || "",
    timestamp: status.timestamp || new Date().toISOString(),
    details: status.details || null
  };

  await Utils.storageSet({ [Utils.STORAGE_KEYS.lastStatus]: normalized });
  return normalized;
}

function validateSubmission(rawSubmission) {
  const submission = {
    title: Utils.cleanProblemTitle(rawSubmission && rawSubmission.title),
    problemUrl: Utils.canonicalProblemUrl(rawSubmission && rawSubmission.problemUrl),
    language: rawSubmission && rawSubmission.language ? rawSubmission.language : "",
    code: rawSubmission && rawSubmission.code ? rawSubmission.code : "",
    submittedAt: rawSubmission && rawSubmission.submittedAt ? rawSubmission.submittedAt : new Date().toISOString()
  };

  const errors = [];

  if (!submission.title) errors.push("problem title");
  if (!submission.problemUrl) errors.push("problem URL");
  if (!submission.language || !Utils.getLanguageConfig(submission.language)) errors.push("supported language");
  if (!submission.code.trim()) errors.push("source code");

  if (errors.length) {
    throw new Error(`Could not extract ${errors.join(", ")}.`);
  }

  return submission;
}

async function syncSubmission(rawSubmission, options = {}) {
  const submission = validateSubmission(rawSubmission);
  const languageConfig = Utils.getLanguageConfig(submission.language);
  submission.language = languageConfig.label;

  const [submissionKey, codeHash] = await Promise.all([
    Utils.makeSubmissionKey(submission),
    Utils.hashString(Utils.normalizeCodeForHash(submission.code))
  ]);

  if (inFlightSubmissions.has(submissionKey)) {
    return { status: "skipped", message: "This accepted solution is already syncing." };
  }

  inFlightSubmissions.add(submissionKey);

  try {
    const history = await loadHistory();
    const duplicate = history.find((item) => item.submissionKey === submissionKey && item.syncState !== "failed");

    if (duplicate && !options.force) {
      // Local metadata prevents repeated commits when HackerRank re-renders the same accepted result.
      const status = await saveLastStatus({
        state: "skipped",
        message: `Skipped duplicate solution for ${submission.title}.`,
        details: duplicate
      });

      notify("Skipped duplicate", `${submission.title} was already synced.`);
      return { status: "skipped", lastStatus: status, history };
    }

    const settings = await loadSettings();
    const client = new GitHubClient(settings);
    const path = Utils.buildSolutionPath(submission);
    const commitMessage = Utils.buildCommitMessage(submission.title);
    const result = await client.createOrUpdateFile({
      path,
      content: submission.code,
      message: commitMessage
    });

    const historyEntry = {
      title: submission.title,
      problemUrl: submission.problemUrl,
      language: submission.language,
      path,
      source: options.source || "automatic",
      submissionKey,
      codeHash,
      submittedAt: submission.submittedAt,
      syncedAt: new Date().toISOString(),
      syncState: result.action,
      commitMessage,
      commitSha: result.commitSha || "",
      htmlUrl: result.htmlUrl || ""
    };

    const nextHistory = [
      historyEntry,
      ...history.filter((item) => item.submissionKey !== submissionKey)
    ];

    await saveHistory(nextHistory);

    const status = await saveLastStatus({
      state: result.action === "unchanged" ? "skipped" : "success",
      message: statusMessageForResult(result.action, submission.title, path),
      details: historyEntry
    });

    notify(
      result.action === "unchanged" ? "No GitHub change needed" : "Solution synced",
      status.message
    );

    return {
      status: result.action,
      lastStatus: status,
      history: nextHistory,
      path,
      htmlUrl: result.htmlUrl || ""
    };
  } catch (error) {
    const failedEntry = {
      title: submission.title,
      problemUrl: submission.problemUrl,
      language: submission.language,
      source: options.source || "automatic",
      submissionKey,
      codeHash,
      submittedAt: submission.submittedAt,
      syncedAt: new Date().toISOString(),
      syncState: "failed",
      error: Utils.toErrorMessage(error)
    };

    const history = await loadHistory();
    await saveHistory([failedEntry, ...history.slice(0, 199)]);
    await saveLastStatus({
      state: "failed",
      message: failedEntry.error,
      details: failedEntry
    });

    notify("GitHub sync failed", failedEntry.error);
    throw error;
  } finally {
    inFlightSubmissions.delete(submissionKey);
  }
}

function statusMessageForResult(action, title, path) {
  if (action === "created") {
    return `Created ${path} for ${title}.`;
  }

  if (action === "updated") {
    return `Updated ${path} for ${title}.`;
  }

  return `${path} already matches the accepted solution.`;
}

async function getStatus() {
  const data = await Utils.storageGet([
    Utils.STORAGE_KEYS.settings,
    Utils.STORAGE_KEYS.history,
    Utils.STORAGE_KEYS.lastStatus
  ]);

  const settings = Utils.mergeSettings(data[Utils.STORAGE_KEYS.settings]);
  const history = Array.isArray(data[Utils.STORAGE_KEYS.history]) ? data[Utils.STORAGE_KEYS.history] : [];
  const lastStatus = data[Utils.STORAGE_KEYS.lastStatus] || {
    state: "idle",
    message: "Waiting for an accepted HackerRank submission.",
    timestamp: null
  };

  return {
    settings: {
      owner: settings.owner,
      repo: settings.repo,
      branch: settings.branch,
      tokenConfigured: Boolean(settings.githubToken),
      tokenPreview: Utils.maskToken(settings.githubToken)
    },
    history,
    lastStatus
  };
}

async function testConnection(overrideSettings) {
  const storedSettings = await loadSettings();
  const client = new GitHubClient({
    ...storedSettings,
    ...(overrideSettings || {}),
    githubToken: overrideSettings && overrideSettings.githubToken
      ? overrideSettings.githubToken
      : storedSettings.githubToken
  });

  const result = await client.testConnection();

  return {
    message: `Connected to ${result.fullName} on ${result.branch}.`,
    repository: result.fullName,
    branch: result.branch
  };
}

function notify(title, message) {
  if (!chrome.notifications) {
    return;
  }

  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message: Utils.truncate(message, 180)
  });
}

async function readMonacoFromTab(tabId) {
  if (!tabId) {
    return { payload: { code: "", language: "" } };
  }

  // Run only the editor reader in the page's MAIN world; the token and GitHub logic stay in this worker.
  const [executionResult] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const result = { code: "", language: "" };

      try {
        const monaco = window.monaco;
        const models = monaco && monaco.editor && typeof monaco.editor.getModels === "function"
          ? monaco.editor.getModels()
          : [];
        const model = models.find((candidate) => {
          try {
            return candidate && typeof candidate.getValue === "function" && candidate.getValue().trim();
          } catch (_) {
            return false;
          }
        }) || models[0];

        if (model) {
          result.code = typeof model.getValue === "function" ? model.getValue() : "";
          result.language = typeof model.getLanguageId === "function" ? model.getLanguageId() : "";
        }
      } catch (error) {
        result.error = error && error.message ? error.message : String(error);
      }

      return result;
    }
  });

  return {
    payload: executionResult && executionResult.result
      ? executionResult.result
      : { code: "", language: "" }
  };
}
