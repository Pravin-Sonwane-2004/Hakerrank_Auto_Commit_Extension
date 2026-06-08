(function contentScript(global) {
  "use strict";

  const Utils = global.HRGitHubSyncUtils;

  const state = {
    lastSubmitClickAt: 0,
    lastSentKey: "",
    lastSentAt: 0,
    route: location.href
  };

  const acceptedSelectorCandidates = [
    "[data-automation*='result' i]",
    "[data-automation*='submission' i]",
    "[data-test-id*='result' i]",
    "[data-test-id*='submission' i]",
    ".challenge-submit-success",
    ".submission-result",
    ".submission-status",
    ".hr-monaco-submit-output",
    ".alert-success",
    ".congrats-heading",
    "[class*='result' i]",
    "[class*='status' i]",
    "[class*='submission' i]"
  ];

  const titleSelectorCandidates = [
    "[data-automation='challenge-title']",
    "[data-test-id='challenge-title']",
    ".challenge-title",
    ".challenge-header h1",
    "header h1",
    "main h1",
    "h1"
  ];

  const languageSelectorCandidates = [
    "[data-automation*='language' i]",
    "[data-test-id*='language' i]",
    "button[aria-label*='language' i]",
    "[aria-label*='language' i]",
    ".language-select",
    ".select-language",
    "[class*='language' i] button",
    "[class*='language' i] span"
  ];

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "HRGS_COLLECT_PAGE_SUBMISSION") {
      return false;
    }

    collectSubmission({ force: Boolean(message.force) })
      .then((submission) => sendResponse({ ok: true, submission }))
      .catch((error) => sendResponse({ ok: false, error: Utils.toErrorMessage(error) }));

    return true;
  });

  document.addEventListener("click", (event) => {
    const target = event.target && event.target.closest
      ? event.target.closest("button, [role='button'], input[type='submit']")
      : null;

    if (!target) {
      return;
    }

    const text = `${target.innerText || ""} ${target.value || ""} ${target.getAttribute("aria-label") || ""}`;

    if (/\bsubmit\b/i.test(text) && /\b(code|solution|answer)?\b/i.test(text)) {
      state.lastSubmitClickAt = Date.now();
      scheduleAcceptedCheck();
    }
  }, true);

  const scheduleAcceptedCheck = Utils.debounce(() => {
    checkForAcceptedSubmission(false).catch((error) => {
      console.warn("[HackerRank GitHub Sync] Accepted-submission check failed.", error);
    });
  }, 900);

  const observer = new MutationObserver(() => scheduleAcceptedCheck());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });

  setInterval(() => {
    if (state.route !== location.href) {
      state.route = location.href;
      state.lastSentKey = "";
      state.lastSentAt = 0;
    }

    scheduleAcceptedCheck();
  }, 4000);

  window.addEventListener("focus", () => scheduleAcceptedCheck());
  scheduleAcceptedCheck();

  async function checkForAcceptedSubmission(force) {
    if (!Utils.isChallengeUrl(location.href)) {
      return;
    }

    // HackerRank is a SPA, so accepted output can appear without a full page navigation.
    const accepted = hasAcceptedEvidence();
    const recentlySubmitted = Date.now() - state.lastSubmitClickAt < 180000;

    if (!force && !accepted && !recentlySubmitted) {
      return;
    }

    if (!force && !accepted) {
      return;
    }

    const submission = await collectSubmission({ force });
    submission.accepted = accepted;

    if (!submission.accepted && !force) {
      return;
    }

    const submissionKey = await Utils.makeSubmissionKey(submission);
    const sentRecently = state.lastSentKey === submissionKey && Date.now() - state.lastSentAt < 120000;

    if (sentRecently) {
      return;
    }

    state.lastSentKey = submissionKey;
    state.lastSentAt = Date.now();

    await Utils.sendRuntimeMessage({
      type: "HRGS_ACCEPTED_SUBMISSION",
      payload: submission
    });
  }

  async function collectSubmission({ force = false } = {}) {
    if (!Utils.isHackerRankUrl(location.href)) {
      throw new Error("This page is not on HackerRank.");
    }

    const monacoData = await readCodeFromPageContext();
    const fallbackCode = readVisibleEditorText();
    const code = monacoData.code || fallbackCode;
    const language = normalizeDetectedLanguage(monacoData.language || readLanguageFromDom());
    const title = readProblemTitle();
    const accepted = hasAcceptedEvidence();

    if (!force && !accepted) {
      throw new Error("No accepted submission result was detected on this page.");
    }

    return {
      title,
      problemUrl: Utils.canonicalProblemUrl(location.href),
      language,
      code,
      submittedAt: new Date().toISOString(),
      accepted
    };
  }

  function hasAcceptedEvidence() {
    const candidateTexts = [];

    for (const selector of acceptedSelectorCandidates) {
      document.querySelectorAll(selector).forEach((element) => {
        if (isElementVisible(element)) {
          const text = compactText(element.innerText || element.textContent || "");

          if (text && text.length < 1200) {
            candidateTexts.push(text);
          }
        }
      });
    }

    const directEvidence = candidateTexts.some((text) => Utils.isAcceptedText(text));

    if (directEvidence) {
      return true;
    }

    if (Date.now() - state.lastSubmitClickAt > 180000) {
      return false;
    }

    return findVisibleAcceptedTextNode();
  }

  function findVisibleAcceptedTextNode() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();

    while (node) {
      const text = compactText(node.nodeValue || "");

      if (Utils.isAcceptedText(text) && isElementVisible(node.parentElement)) {
        return true;
      }

      node = walker.nextNode();
    }

    return false;
  }

  function readProblemTitle() {
    for (const selector of titleSelectorCandidates) {
      const element = document.querySelector(selector);
      const text = element ? compactText(element.innerText || element.textContent || "") : "";

      if (text && !/hackerrank/i.test(text)) {
        return Utils.cleanProblemTitle(text);
      }
    }

    const titleFromDocument = Utils.cleanProblemTitle(document.title);

    if (titleFromDocument) {
      return titleFromDocument;
    }

    const pathParts = location.pathname.split("/").filter(Boolean);
    const challengeIndex = pathParts.lastIndexOf("challenges");
    const slug = challengeIndex >= 0 ? pathParts[challengeIndex + 1] : pathParts[pathParts.length - 1];

    return Utils.cleanProblemTitle(String(slug || "Challenge").replace(/[-_]+/g, " "));
  }

  function readLanguageFromDom() {
    const texts = [];

    for (const selector of languageSelectorCandidates) {
      document.querySelectorAll(selector).forEach((element) => {
        if (!isElementVisible(element)) {
          return;
        }

        const text = compactText(element.innerText || element.textContent || element.getAttribute("aria-label") || "");

        if (text && text.length < 80) {
          texts.push(text);
        }
      });
    }

    const knownLanguage = texts.find((text) => Utils.normalizeLanguage(text));

    if (knownLanguage) {
      return knownLanguage;
    }

    const bodyText = compactText(document.body.innerText || "");
    const languageMatch = bodyText.match(/\b(JavaScript|Java|Python 3|Python|SQL|MySQL|C\+\+|CPP|Node\.js)\b/i);
    return languageMatch ? languageMatch[1] : "";
  }

  function normalizeDetectedLanguage(language) {
    const normalized = Utils.normalizeLanguage(language);
    const config = normalized ? Utils.LANGUAGE_CONFIG[normalized] : null;
    return config ? config.label : language;
  }

  async function readCodeFromPageContext() {
    try {
      // Preferred path: MV3 MAIN-world execution can access window.monaco without fighting page CSP.
      const response = await Utils.sendRuntimeMessage({ type: "HRGS_READ_MONACO_FROM_TAB" });

      if (response && response.ok && response.payload) {
        return response.payload;
      }
    } catch (error) {
      console.warn("[HackerRank GitHub Sync] MAIN-world Monaco read failed.", error);
    }

    const requestId = `${Utils.APP_PREFIX}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

    // Fallback for older Chromium builds or blocked scripting calls.
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve({ code: "", language: "" });
      }, 1200);

      function cleanup() {
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
      }

      function onMessage(event) {
        if (event.source !== window || !event.data || event.data.type !== "HRGS_MONACO_CODE_RESPONSE") {
          return;
        }

        if (event.data.requestId !== requestId) {
          return;
        }

        cleanup();
        resolve(event.data.payload || { code: "", language: "" });
      }

      window.addEventListener("message", onMessage);
      injectPageReader(requestId);
    });
  }

  function injectPageReader(requestId) {
    const script = document.createElement("script");

    script.textContent = `
      (() => {
        const requestId = ${JSON.stringify(requestId)};
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

        window.postMessage({
          type: "HRGS_MONACO_CODE_RESPONSE",
          requestId,
          payload: result
        }, "*");
      })();
    `;

    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();
  }

  function readVisibleEditorText() {
    const textarea = document.querySelector("textarea[data-gramm='false'], textarea.inputarea, textarea");

    if (textarea && textarea.value && textarea.value.trim().length > 20) {
      return textarea.value;
    }

    const monacoLines = Array.from(document.querySelectorAll(".monaco-editor .view-lines .view-line"))
      .filter(isElementVisible)
      .map((line) => line.textContent || "");

    if (monacoLines.length) {
      return monacoLines.join("\n");
    }

    const aceLines = Array.from(document.querySelectorAll(".ace_editor .ace_line"))
      .filter(isElementVisible)
      .map((line) => line.textContent || "");

    return aceLines.join("\n");
  }

  function isElementVisible(element) {
    if (!element || !element.getBoundingClientRect) {
      return false;
    }

    const style = window.getComputedStyle(element);

    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function compactText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }
})(globalThis);
