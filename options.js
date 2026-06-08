(function optionsPage(global) {
  "use strict";

  const Utils = global.HRGitHubSyncUtils;

  const form = document.getElementById("settingsForm");
  const fields = {
    githubToken: document.getElementById("githubToken"),
    owner: document.getElementById("owner"),
    repo: document.getElementById("repo"),
    branch: document.getElementById("branch")
  };
  const buttons = {
    clearToken: document.getElementById("clearToken"),
    save: document.getElementById("save"),
    test: document.getElementById("test")
  };
  const status = document.getElementById("status");
  const tokenState = document.getElementById("tokenState");

  let currentSettings = Utils.mergeSettings();

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    form.addEventListener("submit", saveSettings);
    buttons.test.addEventListener("click", testConnection);
    buttons.clearToken.addEventListener("click", clearToken);
    loadSettings();
  }

  async function loadSettings() {
    try {
      const data = await Utils.storageGet(Utils.STORAGE_KEYS.settings);
      currentSettings = Utils.mergeSettings(data[Utils.STORAGE_KEYS.settings]);
      fields.owner.value = currentSettings.owner;
      fields.repo.value = currentSettings.repo;
      fields.branch.value = currentSettings.branch;
      fields.githubToken.value = "";
      renderTokenState();
    } catch (error) {
      setStatus(Utils.toErrorMessage(error), "error");
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    setLoading(true);

    try {
      const nextSettings = readFormSettings();
      await Utils.storageSet({ [Utils.STORAGE_KEYS.settings]: nextSettings });
      currentSettings = nextSettings;
      fields.githubToken.value = "";
      renderTokenState();
      setStatus("Settings saved.", "success");
    } catch (error) {
      setStatus(Utils.toErrorMessage(error), "error");
    } finally {
      setLoading(false);
    }
  }

  async function testConnection() {
    buttons.test.disabled = true;

    try {
      const settings = readFormSettings();
      const response = await Utils.sendRuntimeMessage({
        type: "HRGS_TEST_CONNECTION",
        settings
      });

      if (!response.ok) {
        throw new Error(response.error);
      }

      setStatus(response.message, "success");
    } catch (error) {
      setStatus(Utils.toErrorMessage(error), "error");
    } finally {
      buttons.test.disabled = false;
    }
  }

  async function clearToken() {
    const nextSettings = {
      ...currentSettings,
      githubToken: ""
    };

    try {
      await Utils.storageSet({ [Utils.STORAGE_KEYS.settings]: nextSettings });
      currentSettings = nextSettings;
      fields.githubToken.value = "";
      renderTokenState();
      setStatus("Token cleared.", "success");
    } catch (error) {
      setStatus(Utils.toErrorMessage(error), "error");
    }
  }

  function readFormSettings() {
    const tokenFromForm = fields.githubToken.value.trim();
    const nextSettings = Utils.mergeSettings({
      githubToken: tokenFromForm || currentSettings.githubToken,
      owner: fields.owner.value.trim(),
      repo: fields.repo.value.trim(),
      branch: fields.branch.value.trim() || "main"
    });

    const missing = [];

    if (!nextSettings.githubToken) missing.push("GitHub token");
    if (!nextSettings.owner) missing.push("repository owner");
    if (!nextSettings.repo) missing.push("repository name");
    if (!nextSettings.branch) missing.push("branch name");

    if (missing.length) {
      throw new Error(`Missing ${missing.join(", ")}.`);
    }

    return nextSettings;
  }

  function renderTokenState() {
    tokenState.textContent = currentSettings.githubToken
      ? `Token saved: ${Utils.maskToken(currentSettings.githubToken)}`
      : "No GitHub token saved";
  }

  function setStatus(message, state) {
    status.textContent = message;
    status.className = state || "";
  }

  function setLoading(isLoading) {
    buttons.save.disabled = isLoading;
    buttons.save.classList.toggle("loading", isLoading);
  }
})(globalThis);
