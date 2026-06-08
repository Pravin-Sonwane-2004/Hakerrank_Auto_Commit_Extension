(function popup(global) {
  "use strict";

  const Utils = global.HRGitHubSyncUtils;

  const elements = {
    clearHistory: document.getElementById("clearHistory"),
    historyList: document.getElementById("historyList"),
    openOptions: document.getElementById("openOptions"),
    repoSummary: document.getElementById("repoSummary"),
    statusCard: document.getElementById("statusCard"),
    statusMessage: document.getElementById("statusMessage"),
    statusTitle: document.getElementById("statusTitle"),
    syncCurrent: document.getElementById("syncCurrent")
  };

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    elements.openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
    elements.syncCurrent.addEventListener("click", syncCurrentPage);
    elements.clearHistory.addEventListener("click", clearHistory);
    refresh();
  }

  async function refresh() {
    try {
      const status = await Utils.sendRuntimeMessage({ type: "HRGS_GET_STATUS" });

      if (!status.ok) {
        throw new Error(status.error);
      }

      renderStatus(status);
      renderHistory(status.history || []);
    } catch (error) {
      renderError(Utils.toErrorMessage(error));
    }
  }

  async function syncCurrentPage() {
    setLoading(true);

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab || !tab.id || !Utils.isHackerRankUrl(tab.url || "")) {
        throw new Error("Open an accepted HackerRank challenge page before syncing.");
      }

      const pageResponse = await chrome.tabs.sendMessage(tab.id, {
        type: "HRGS_COLLECT_PAGE_SUBMISSION",
        force: false
      });

      if (!pageResponse || !pageResponse.ok) {
        throw new Error(pageResponse && pageResponse.error ? pageResponse.error : "Could not read the HackerRank page.");
      }

      const syncResponse = await Utils.sendRuntimeMessage({
        type: "HRGS_SYNC_SUBMISSION",
        payload: pageResponse.submission,
        force: false
      });

      if (!syncResponse.ok) {
        throw new Error(syncResponse.error);
      }

      await refresh();
    } catch (error) {
      renderError(Utils.toErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function clearHistory() {
    elements.clearHistory.disabled = true;

    try {
      const response = await Utils.sendRuntimeMessage({ type: "HRGS_CLEAR_HISTORY" });

      if (!response.ok) {
        throw new Error(response.error);
      }

      renderStatus(response);
      renderHistory(response.history || []);
    } catch (error) {
      renderError(Utils.toErrorMessage(error));
    } finally {
      elements.clearHistory.disabled = false;
    }
  }

  function renderStatus(payload) {
    const settings = payload.settings || {};
    const lastStatus = payload.lastStatus || {};
    const configured = settings.tokenConfigured && settings.owner && settings.repo && settings.branch;

    elements.repoSummary.textContent = configured
      ? `${settings.owner}/${settings.repo} - ${settings.branch}`
      : "Settings not configured";

    elements.statusCard.className = `status ${lastStatus.state || "idle"}`;
    elements.statusTitle.textContent = titleForState(lastStatus.state);
    elements.statusMessage.textContent = lastStatus.message || "Waiting for an accepted HackerRank submission.";
  }

  function renderError(message) {
    elements.statusCard.className = "status failed";
    elements.statusTitle.textContent = "Needs attention";
    elements.statusMessage.textContent = message;
  }

  function renderHistory(history) {
    elements.historyList.innerHTML = "";

    if (!history.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No submissions synced yet.";
      elements.historyList.appendChild(empty);
      return;
    }

    history.slice(0, 8).forEach((entry) => {
      const item = document.createElement("article");
      item.className = "entry";

      const title = document.createElement("p");
      title.className = "entry-title";
      title.textContent = entry.title || "Untitled challenge";

      const meta = document.createElement("div");
      meta.className = "muted";
      meta.textContent = `${entry.language || "Unknown"} - ${entry.syncState || "synced"} - ${Utils.formatDateTime(entry.syncedAt)}`;

      const path = document.createElement("p");
      path.className = "entry-path";
      path.textContent = entry.path || entry.error || "";

      item.append(title, meta, path);
      elements.historyList.appendChild(item);
    });
  }

  function titleForState(state) {
    switch (state) {
      case "success":
        return "Synced";
      case "failed":
        return "Failed";
      case "skipped":
        return "No duplicate commit";
      default:
        return "Ready";
    }
  }

  function setLoading(isLoading) {
    elements.syncCurrent.disabled = isLoading;
    elements.syncCurrent.classList.toggle("loading", isLoading);
  }
})(globalThis);
